"""
Workflow:
Excel (recipients.xlsx: name, phone) -> Claude API (Personalize) -> Evolution API (Image + Message)
"""

import os
import sys
import time
import re
import base64
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

# Optional Anthropic SDK import
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


def load_recipients(excel_path: str):
    """Load and validate recipient records from Excel (robust column matching)."""
    if not os.path.exists(excel_path):
        raise FileNotFoundError(f"Excel file not found at: {excel_path}")

    df = pd.read_excel(excel_path)
    
    # Normalize column names for flexible matching
    col_map = {}
    for col in df.columns:
        norm = re.sub(r"[^a-z0-9]", "", str(col).lower())
        col_map[col] = norm

    # Find name and phone column names
    name_col = None
    phone_col = None

    for original_col, norm in col_map.items():
        if norm in ["name", "fullname", "recipient", "person", "contactname"]:
            name_col = original_col
        elif any(k in norm for k in ["phone", "phno", "phoneno", "mobile", "contact", "number"]):
            phone_col = original_col

    # Fallback to index if 2 columns
    if not name_col or not phone_col:
        if len(df.columns) >= 2:
            # Check which column looks like phone (contains digits)
            first_val = str(df.iloc[0, 0]) if len(df) > 0 else ""
            second_val = str(df.iloc[0, 1]) if len(df) > 0 else ""
            if any(c.isdigit() for c in first_val):
                phone_col = df.columns[0]
                name_col = df.columns[1]
            else:
                name_col = df.columns[0]
                phone_col = df.columns[1]

    total_records = len(df)
    valid_records = []

    for idx, row in df.iterrows():
        name = str(row.get(name_col, "")).strip() if name_col and pd.notna(row.get(name_col)) else ""
        raw_phone = row.get(phone_col, "") if phone_col else ""
        phone = clean_phone_number(raw_phone)

        if name and phone:
            valid_records.append({
                "row_idx": idx + 2,
                "name": name,
                "phone": phone,
            })

    return total_records, valid_records


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
2. Keep the personalized message between 50 and 100 words.
3. Maintain a warm, clear, and professional tone.
4. Output ONLY the final personalized message text. Do not include markdown quotes, explanations, or greeting prefixes outside the message.

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
    except Exception as e:
        return fallback_personalize(template, recipient)


def image_to_base64(image_path: str) -> str:
    """Read an image file and convert to base64 string."""
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image not found at {image_path}")
    with open(image_path, "rb") as img_file:
        return base64.b64encode(img_file.read()).decode("utf-8")


def check_or_create_evolution_instance(api_url: str, api_key: str, instance_name: str) -> bool:
    """Ensure WhatsApp gateway is running and WhatsApp is connected."""
    headers = {"apikey": api_key, "Content-Type": "application/json"}

    # 1. Check if gateway server is responsive
    is_up = False
    for _ in range(5):
        try:
            res = requests.get(f"{api_url}/instance/connectionState/{instance_name}", headers=headers, timeout=2)
            if res.status_code == 200:
                is_up = True
                break
        except requests.exceptions.RequestException:
            time.sleep(1)

    if not is_up:
        print(f"\n[Error] WhatsApp Gateway is not responding at {api_url}.", flush=True)
        print("Please ensure 'node gateway.js' is running.\n", flush=True)
        return False

    # 2. Check connection state
    try:
        state_res = requests.get(f"{api_url}/instance/connectionState/{instance_name}", headers=headers, timeout=3)
        state = state_res.json().get("instance", {}).get("state") if state_res.status_code == 200 else None
    except Exception:
        state = None

    if state == "open":
        print("[WhatsApp Gateway] [OK] WhatsApp Connected & Ready!", flush=True)
        return True

    # 3. If not connected, fetch pairing code and wait for user to enter it on their phone
    print("[WhatsApp Gateway] WhatsApp is not linked yet. Generating pairing code...", flush=True)
    last_printed_code = None

    for _ in range(60): # Wait up to 120 seconds
        try:
            code_res = requests.get(f"{api_url}/instance/pairingCode", timeout=3)
            data = code_res.json() if code_res.status_code == 200 else {}
            curr_state = data.get("state")
            code = data.get("code")

            if curr_state == "open":
                print("\n[OK] WHATSAPP LINKED SUCCESSFULLY & READY TO SEND!\n", flush=True)
                return True

            if code and code != last_printed_code:
                last_printed_code = code
                print("\n============================================================", flush=True)
                print("              [KEY] YOUR WHATSAPP PAIRING CODE               ", flush=True)
                print("============================================================", flush=True)
                print(f"\n                     >>  {code}  <<\n", flush=True)
                print("------------------------------------------------------------", flush=True)
                print("Web Dashboard: http://localhost:8085", flush=True)
                print("On your phone:", flush=True)
                print("1. Open WhatsApp Business -> Settings -> Linked Devices", flush=True)
                print("2. Tap 'Link a Device'", flush=True)
                print("3. Tap 'Link with phone number instead' at the bottom", flush=True)
                print(f"4. Enter this 8-character code: {code}", flush=True)
                print("============================================================", flush=True)
                print("Waiting for you to enter the code on your phone...", flush=True)

        except Exception:
            pass

        time.sleep(2)

    print("\n[Timeout] Pairing code expired or took too long. Please run again.", flush=True)
    return False


def send_evolution_media_message(api_url: str, api_key: str, instance_name: str, phone: str, image_b64: str, caption: str) -> dict:
    """Send image with caption using Evolution API."""
    url = f"{api_url}/message/sendMedia/{instance_name}"
    headers = {
        "apikey": api_key,
        "Content-Type": "application/json"
    }

    payload = {
        "number": phone,
        "mediatype": "image",
        "mimetype": "image/jpeg",
        "caption": caption,
        "media": image_b64,
        "fileName": "campaign.jpg"
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        res_json = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}

        if response.status_code in (200, 201):
            key_id = res_json.get("key", {}).get("id") or "SENT_OK"
            return {"success": True, "id": key_id}
        else:
            err = res_json.get("response", {}).get("message") or response.text
            return {"success": False, "error": f"HTTP {response.status_code}: {err}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def send_evolution_text_message(api_url: str, api_key: str, instance_name: str, phone: str, text: str) -> dict:
    """Send text message using Evolution API."""
    url = f"{api_url}/message/sendText/{instance_name}"
    headers = {
        "apikey": api_key,
        "Content-Type": "application/json"
    }

    payload = {
        "number": phone,
        "text": text
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        res_json = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}

        if response.status_code in (200, 201):
            key_id = res_json.get("key", {}).get("id") or "SENT_OK"
            return {"success": True, "id": key_id}
        else:
            err = res_json.get("response", {}).get("message") or response.text
            return {"success": False, "error": f"HTTP {response.status_code}: {err}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Evolution API + Claude Campaign Runner (Name & Phone)")
    parser.add_argument("--excel", default="recipients.xlsx", help="Path to recipients.xlsx")
    parser.add_argument("--message", default="message.txt", help="Path to message.txt template")
    parser.add_argument("--image", default="campaign.jpg", help="Path to campaign.jpg")
    parser.add_argument("--dry-run", action="store_true", help="Simulate message generation without sending")
    parser.add_argument("--test-numbers", help="Comma-separated list of test numbers to override .env")
    args = parser.parse_args()

    # Load environment variables
    load_dotenv(override=True)

    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    claude_model = os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-latest").strip()
    use_claude_env = os.getenv("USE_CLAUDE", "true").strip().lower() == "true"

    port = os.getenv("PORT", "8085")
    evolution_url = os.getenv("EVOLUTION_API_URL", f"http://localhost:{port}").rstrip("/")
    evolution_key = os.getenv("EVOLUTION_API_KEY", "my_secret_api_key_12345").strip()
    evolution_instance = os.getenv("EVOLUTION_INSTANCE_NAME", "campaign_instance").strip()
    delay_seconds = float(os.getenv("MESSAGE_DELAY_SECONDS", "2.0"))

    # Determine test phone numbers
    test_numbers_raw = args.test_numbers or os.getenv("TEST_PHONE_NUMBERS", "")
    test_phone_set = {clean_phone_number(p) for p in test_numbers_raw.split(",") if clean_phone_number(p)}

    print("============================================================", flush=True)
    print("   EVOLUTION API (100% FREE) + CLAUDE AUTOMATION WORKFLOW   ", flush=True)
    print("============================================================", flush=True)

    # 1. Load message template
    if not os.path.exists(args.message):
        print(f"[Error] Message template file '{args.message}' not found!", flush=True)
        sys.exit(1)
    with open(args.message, "r", encoding="utf-8") as f:
        template_text = f.read().strip()

    # 2. Load Excel recipients
    try:
        total_records, valid_records = load_recipients(args.excel)
    except Exception as e:
        print(f"[Error] Failed to read Excel file: {e}", flush=True)
        sys.exit(1)

    # Filter for test recipients if specified
    if test_phone_set:
        recipients_to_send = [r for r in valid_records if r["phone"] in test_phone_set]
        test_count = len(recipients_to_send)
    else:
        recipients_to_send = valid_records
        test_count = 0

    print(f"Total Excel records: {total_records}", flush=True)
    print(f"Valid records:       {len(valid_records)}", flush=True)
    if test_phone_set:
        print(f"Test recipients:     {test_count}", flush=True)
    else:
        print(f"Mode:                LIVE SEND (All {len(valid_records)} valid records)", flush=True)
    print("------------------------------------------------------------\n", flush=True)

    if not recipients_to_send:
        print("[Notice] No recipients match the sending criteria. Exiting.", flush=True)
        sys.exit(0)

    # 3. Setup Claude client
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
        print("[Claude AI] Disabled or key not set. Using template variable substitution ({{name}}).", flush=True)

    # 4. Prepare Image (optional)
    has_image = os.path.exists(args.image)
    if has_image:
        try:
            img_b64 = image_to_base64(args.image)
            print(f"[Campaign Media] Attached image: '{args.image}'", flush=True)
        except Exception as e:
            print(f"[Warning] Failed to read image '{args.image}': {e}. Sending as text message.", flush=True)
            has_image = False
            img_b64 = None
    else:
        img_b64 = None
        print("[Campaign Media] No image uploaded. Sending personalized text campaign.", flush=True)

    # 5. Check Evolution API connection (skip if dry-run)
    if not args.dry_run:
        is_connected = check_or_create_evolution_instance(evolution_url, evolution_key, evolution_instance)
        if not is_connected:
            sys.exit(1)
    else:
        print("\n[INFO] Running in DRY RUN / SIMULATION MODE (No actual WhatsApp messages will be sent)", flush=True)

    # 6. Process and send to recipients
    sent_count = 0
    failed_count = 0

    print("\n=================== DISPATCHING MESSAGES ===================", flush=True)
    for idx, recipient in enumerate(recipients_to_send, 1):
        name = recipient["name"]
        phone = recipient["phone"]

        # Personalize Message
        personalized_msg = personalize_with_claude(claude_client, claude_model, template_text, recipient)

        # Output recipient header
        print(f"\n{name}", flush=True)
        print(f"+{phone}", flush=True)
        print(f"Message: {personalized_msg}", flush=True)

        # Send via Evolution API
        if args.dry_run:
            print("Status: SENT (Dry Run Simulation)", flush=True)
            sent_count += 1
        else:
            if has_image and img_b64:
                result = send_evolution_media_message(
                    api_url=evolution_url,
                    api_key=evolution_key,
                    instance_name=evolution_instance,
                    phone=phone,
                    image_b64=img_b64,
                    caption=personalized_msg
                )
            else:
                result = send_evolution_text_message(
                    api_url=evolution_url,
                    api_key=evolution_key,
                    instance_name=evolution_instance,
                    phone=phone,
                    text=personalized_msg
                )

            if result["success"]:
                print(f"Status: SENT", flush=True)
                sent_count += 1
            else:
                print(f"Status: FAILED", flush=True)
                print(f"Reason: {result['error']}", flush=True)
                failed_count += 1

            # Throttle delay
            if idx < len(recipients_to_send):
                time.sleep(delay_seconds)

    print("\n====================== CAMPAIGN SUMMARY ======================", flush=True)
    print(f"Total Processed: {len(recipients_to_send)}", flush=True)
    print(f"Successful:      {sent_count}", flush=True)
    print(f"Failed:          {failed_count}", flush=True)
    print("==============================================================", flush=True)


if __name__ == "__main__":
    main()
