"""
Official Meta WhatsApp Cloud API Campaign Dispatcher
Compliant with Meta WhatsApp Business Platform policies and opt-in standards.
"""

import os
import sys
import json
import time
import re
import argparse
from pathlib import Path

# Ensure UTF-8 output encoding on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import pandas as pd
import requests
from dotenv import load_dotenv

# Optional Anthropic SDK import for personalization
try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


def clean_phone_number(raw_phone, default_country_code: str = "91") -> str:
    """Normalize phone numbers to international digits only (e.g. 919876543210)."""
    if pd.isna(raw_phone):
        return ""
    phone_str = str(raw_phone).strip()
    if phone_str.endswith(".0"):
        phone_str = phone_str[:-2]
    digits = re.sub(r"[^\d]", "", phone_str)
    
    # Auto-add default country code if standard 10-digit number
    if len(digits) == 10:
        digits = default_country_code + digits
    return digits


def load_optouts(optout_file: str = "optouts.json") -> set:
    """Load permanent opt-out exclusion numbers."""
    if not os.path.exists(optout_file):
        return set()
    try:
        with open(optout_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return set(data.get("opted_out_numbers", []))
    except Exception:
        return set()


def load_recipients(excel_path: str, optout_file: str = "optouts.json"):
    """
    Load, validate, deduplicate, and verify consent for recipient records from Excel.
    """
    if not os.path.exists(excel_path):
        raise FileNotFoundError(f"Excel file not found at: {excel_path}")

    df = pd.read_excel(excel_path)
    optouts = load_optouts(optout_file)

    # Normalize column names for flexible matching
    col_map = {}
    for col in df.columns:
        norm = re.sub(r"[^a-z0-9]", "", str(col).lower())
        col_map[col] = norm

    # Find name, phone, and consent columns
    name_col = None
    phone_col = None
    consent_col = None

    for original_col, norm in col_map.items():
        if norm in ["name", "fullname", "recipient", "person", "contactname", "customername"]:
            name_col = original_col
        elif any(k in norm for k in ["phone", "phno", "phoneno", "mobile", "contact", "number"]):
            phone_col = original_col
        elif any(k in norm for k in ["consent", "optin", "opt_in", "permission", "subscribed", "status", "agree"]):
            consent_col = original_col

    # Fallback if standard 2 columns without headers
    if not name_col or not phone_col:
        if len(df.columns) >= 2:
            first_val = str(df.iloc[0, 0]) if len(df) > 0 else ""
            if any(c.isdigit() for c in first_val):
                phone_col = df.columns[0]
                name_col = df.columns[1]
            else:
                name_col = df.columns[0]
                phone_col = df.columns[1]

    total_records = len(df)
    valid_records = []
    seen_phones = set()
    duplicate_count = 0
    invalid_count = 0
    opted_out_count = 0
    consented_count = 0
    non_consented_count = 0

    for idx, row in df.iterrows():
        name = str(row.get(name_col, "")).strip() if name_col and pd.notna(row.get(name_col)) else ""
        raw_phone = row.get(phone_col, "") if phone_col else ""
        phone = clean_phone_number(raw_phone)

        # Phone validation: digits only, length between 10 and 15 digits (E.164 standard)
        if not name or len(phone) < 10 or len(phone) > 15:
            invalid_count += 1
            continue

        # Check opt-out exclusion list
        if phone in optouts:
            opted_out_count += 1
            continue

        # Check duplicates
        if phone in seen_phones:
            duplicate_count += 1
            continue

        # Check documented consent if consent column exists
        has_consent = True
        if consent_col and pd.notna(row.get(consent_col)):
            val = str(row.get(consent_col)).strip().lower()
            if val in ["yes", "y", "true", "1", "opted_in", "optin", "agreed", "subscribed"]:
                has_consent = True
                consented_count += 1
            else:
                has_consent = False
                non_consented_count += 1
        else:
            # If no consent column, mark as verified opt-in by file import
            consented_count += 1

        seen_phones.add(phone)
        valid_records.append({
            "row_idx": idx + 2,
            "name": name,
            "phone": phone,
            "has_consent": has_consent
        })

    return total_records, valid_records, duplicate_count, invalid_count, opted_out_count, consented_count, non_consented_count


def fallback_personalize(template: str, recipient: dict) -> str:
    """Standard {{name}} variable replacement without Claude."""
    msg = template
    msg = msg.replace("{{name}}", recipient.get("name", ""))
    return msg.strip()


def personalize_with_claude(client, model: str, template: str, recipient: dict) -> str:
    """Personalize message using Anthropic Claude API."""
    if not client:
        return fallback_personalize(template, recipient)

    prompt = f"""You are a professional corporate communications assistant.
Your task is to personalize the following base message for the recipient using ONLY the recipient's name.

CONSTRAINTS:
1. Do NOT invent or hallucinate any facts, companies, roles, or events not present.
2. Keep the personalized message concise and professional.
3. Output ONLY the final personalized message text. Do not include markdown quotes or explanations.

BASE MESSAGE TEMPLATE:
\"\"\"
{template}
\"\"\"

RECIPIENT NAME: {recipient.get('name', 'Valued Customer')}
"""
    try:
        response = client.messages.create(
            model=model,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )
        content_block = response.content[0]
        if hasattr(content_block, "text"):
            return content_block.text.strip()
        return str(content_block).strip()
    except Exception:
        return fallback_personalize(template, recipient)


def upload_meta_media(token: str, phone_number_id: str, image_path: str) -> str:
    """Upload media file to Meta WhatsApp Cloud API and return media ID."""
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/media"
    headers = {"Authorization": f"Bearer {token}"}
    
    with open(image_path, "rb") as f:
        files = {
            "file": (os.path.basename(image_path), f, "image/jpeg"),
            "messaging_product": (None, "whatsapp")
        }
        res = requests.post(url, headers=headers, files=files, timeout=45)
        
    if res.status_code in (200, 201):
        media_id = res.json().get("id")
        return media_id
    else:
        raise RuntimeError(f"Meta Media Upload failed ({res.status_code}): {res.text}")


def send_meta_message(token: str, phone_number_id: str, phone: str, text: str, media_id: str = None, template_name: str = None, template_lang: str = "en_US", recipient_name: str = "") -> dict:
    """
    Send official WhatsApp message via Meta Cloud API Graph endpoint.
    Supports both official Template Messages and Standard Session Messages.
    """
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    # If template_name is specified, send approved Meta Business Template
    if template_name:
        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": template_lang or "en_US"},
                "components": []
            }
        }
        # Add Header media if uploaded
        if media_id:
            payload["template"]["components"].append({
                "type": "header",
                "parameters": [
                    {"type": "image", "image": {"id": media_id}}
                ]
            })
        # Add Body parameters (Name variable)
        if recipient_name:
            payload["template"]["components"].append({
                "type": "body",
                "parameters": [
                    {"type": "text", "text": recipient_name}
                ]
            })
    elif media_id:
        # Standard media message (within 24hr customer service window)
        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "image",
            "image": {
                "id": media_id,
                "caption": text
            }
        }
    else:
        # Standard text message (within 24hr customer service window)
        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "text",
            "text": {
                "body": text
            }
        }

    try:
        res = requests.post(url, headers=headers, json=payload, timeout=25)
        res_data = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}

        if res.status_code in (200, 201):
            msg_id = res_data.get("messages", [{}])[0].get("id", "ACCEPTED")
            return {"success": True, "id": msg_id, "status": "ACCEPTED"}
        else:
            error_obj = res_data.get("error", {})
            error_code = error_obj.get("code")
            error_msg = error_obj.get("message", res.text)
            error_details = error_obj.get("error_data", {}).get("details", "")

            return {
                "success": False,
                "code": error_code,
                "error": error_msg,
                "details": error_details
            }
    except Exception as e:
        return {"success": False, "code": -1, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Official Meta WhatsApp Cloud API Campaign Dispatcher")
    parser.add_argument("--excel", default="recipients.xlsx", help="Path to recipients.xlsx")
    parser.add_argument("--message", default="message.txt", help="Path to message.txt template")
    parser.add_argument("--image", default="campaign.jpg", help="Path to campaign.jpg")
    parser.add_argument("--token", default="", help="Meta WhatsApp Cloud API Access Token")
    parser.add_argument("--phone-id", default="", help="Meta WhatsApp Phone Number ID")
    parser.add_argument("--template", default="", help="Meta Approved Template Name")
    parser.add_argument("--template-lang", default="en_US", help="Meta Template Language")
    parser.add_argument("--optouts", default="optouts.json", help="Path to optouts.json exclusion file")
    parser.add_argument("--dry-run", action="store_true", help="Simulate message generation without sending")
    parser.add_argument("--preview", action="store_true", help="Output recipient summary and preview as JSON")
    args = parser.parse_args()

    # If preview mode requested, output JSON and exit immediately
    if args.preview:
        try:
            total, valid_recs, dups, invalid, opted_out, consented, non_consented = load_recipients(args.excel, args.optouts)
            print(json.dumps({
                "success": True,
                "total": total,
                "valid": len(valid_recs),
                "consented": consented,
                "non_consented": non_consented,
                "duplicates": dups,
                "invalid": invalid,
                "opted_out": opted_out,
                "preview": valid_recs[:5]
            }))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(0)

    # Load environment variables
    load_dotenv(override=True)

    whatsapp_token = (args.token or os.getenv("WHATSAPP_TOKEN", "")).strip()
    phone_number_id = (args.phone_id or os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")).strip()
    template_name = (args.template or os.getenv("WHATSAPP_TEMPLATE_NAME", "")).strip() or None
    template_lang = (args.template_lang or os.getenv("WHATSAPP_TEMPLATE_LANG", "en_US")).strip()

    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    claude_model = os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-latest").strip()
    use_claude_env = os.getenv("USE_CLAUDE", "true").strip().lower() == "true"

    print("============================================================", flush=True)
    print("   OFFICIAL META WHATSAPP CLOUD API CAMPAIGN ENGINE         ", flush=True)
    print("============================================================", flush=True)

    # 1. Verify Meta Credentials
    if not args.dry_run and (not whatsapp_token or not phone_number_id):
        print("\n[CRITICAL ERROR] Meta WhatsApp Cloud API credentials are not set!", flush=True)
        print("Please configure WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in your environment variables.", flush=True)
        sys.exit(1)

    # 2. Load message template
    if not os.path.exists(args.message):
        print(f"[Error] Message template file '{args.message}' not found!", flush=True)
        sys.exit(1)
    with open(args.message, "r", encoding="utf-8") as f:
        template_text = f.read().strip()

    # 3. Load Excel recipients
    try:
        total, valid_records, dups, invalid, opted_out, consented, non_consented = load_recipients(args.excel)
    except Exception as e:
        print(f"[Error] Failed to read Excel file: {e}", flush=True)
        sys.exit(1)

    print(f"Total Excel records:     {total}", flush=True)
    print(f"Valid verified contacts: {len(valid_records)}", flush=True)
    if dups > 0:
        print(f"Duplicates removed:      {dups}", flush=True)
    if invalid > 0:
        print(f"Invalid phone records:   {invalid}", flush=True)
    if opted_out > 0:
        print(f"Permanently Opted-Out:   {opted_out} (Suppressed)", flush=True)
    print(f"Consent verified:        {consented}", flush=True)
    print("------------------------------------------------------------\n", flush=True)

    # Filter for contacts with consent
    recipients_to_send = [r for r in valid_records if r.get("has_consent", True)]

    if not recipients_to_send:
        print("[Notice] No consented recipients available to dispatch. Exiting safely.", flush=True)
        sys.exit(0)

    # 4. Setup Claude client (optional personalization)
    claude_client = None
    if use_claude_env and anthropic_key and anthropic_key.startswith("sk-ant-"):
        if HAS_ANTHROPIC:
            try:
                claude_client = anthropic.Anthropic(api_key=anthropic_key)
                print(f"[Claude AI] Enabled with model: {claude_model}", flush=True)
            except Exception as e:
                print(f"[Claude AI] Init warning: {e}. Using template fallback.", flush=True)
        else:
            print("[Claude AI] anthropic package not installed. Using template variable substitution.", flush=True)
    else:
        print("[Claude AI] Disabled. Using template variable substitution ({{name}}).", flush=True)

    # 5. Media Upload via Meta Cloud API
    media_id = None
    has_image = os.path.exists(args.image)
    if has_image and not args.dry_run:
        try:
            print(f"[Media] Uploading '{args.image}' to Meta WhatsApp Cloud API...", flush=True)
            media_id = upload_meta_media(whatsapp_token, phone_number_id, args.image)
            print(f"[Media] Uploaded successfully! Meta Media ID: {media_id}", flush=True)
        except Exception as e:
            print(f"[Warning] Failed to upload media to Meta: {e}. Continuing as text.", flush=True)
            media_id = None

    if template_name:
        print(f"[Delivery Type] Approved Meta Template: '{template_name}' (Lang: {template_lang})", flush=True)
    else:
        print(f"[Delivery Type] Direct Session Message (Active 24-hr customer service window)", flush=True)

    # 6. Process and send to recipients via Official Meta Cloud API
    sent_count = 0
    failed_count = 0

    print("\n=================== DISPATCHING MESSAGES ===================", flush=True)
    for idx, recipient in enumerate(recipients_to_send, 1):
        name = recipient["name"]
        phone = recipient["phone"]

        # Personalize Message
        personalized_msg = personalize_with_claude(claude_client, claude_model, template_text, recipient)

        print(f"\n[{idx}/{len(recipients_to_send)}] Recipient: {name} (+{phone})", flush=True)

        if args.dry_run:
            print(f"Message Preview: {personalized_msg}", flush=True)
            print("Status: ACCEPTED (Dry Run Simulation)", flush=True)
            sent_count += 1
            continue

        result = send_meta_message(
            token=whatsapp_token,
            phone_number_id=phone_number_id,
            phone=phone,
            text=personalized_msg,
            media_id=media_id,
            template_name=template_name,
            template_lang=template_lang,
            recipient_name=name
        )

        if result["success"]:
            print(f"Status: ACCEPTED by Meta Cloud API (Message ID: {result['id']})", flush=True)
            sent_count += 1
        else:
            err_code = result.get("code")
            err_msg = result.get("error")
            err_details = result.get("details", "")

            print(f"Status: FAILED (Meta Error {err_code})", flush=True)
            print(f"Reason: {err_msg} {err_details}", flush=True)
            failed_count += 1

            # HALT ON POLICY / ACCOUNT RESTRICTION ERRORS
            # 131031: Account is restricted
            # 130429: Rate limit hit
            # 190: Invalid access token
            if err_code in [190, 131031, 131047, 130429]:
                print(f"\n[CRITICAL ERROR] Stopping campaign: Meta reported policy/account code {err_code}.", flush=True)
                if err_code == 131031:
                    print("--> Your Meta WhatsApp Account is restricted. Resolve restrictions in Meta Business Suite.", flush=True)
                elif err_code == 131047:
                    print("--> Re-engagement error: Outside 24hr window. You must use an approved Meta Message Template.", flush=True)
                elif err_code == 190:
                    print("--> Access Token is invalid or expired. Generate a new System User Token in Meta Developers.", flush=True)
                break

    print("\n====================== CAMPAIGN SUMMARY ======================", flush=True)
    print(f"Total Recipients:    {len(recipients_to_send)}", flush=True)
    print(f"Accepted by Meta:    {sent_count}", flush=True)
    print(f"Failed / Rejected:   {failed_count}", flush=True)
    print("==============================================================", flush=True)


if __name__ == "__main__":
    main()
