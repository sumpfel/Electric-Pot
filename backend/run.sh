#!/usr/bin/env bash
# Start the Garden Survailor backend.
# The dashboard will be at http://<this-machine-ip>:8000/
set -e
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating virtualenv..."
  python3 -m venv venv
fi

./venv/bin/python -m pip install --quiet --upgrade pip
./venv/bin/python -m pip install --quiet -r requirements.txt

# Bind to 0.0.0.0 so the ESP32 on your LAN can reach it.
exec ./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
