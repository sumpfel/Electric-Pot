"""Configuration for the Garden Survailor backend."""
import os

# Shared secret the ESP32 must send in the `X-API-Key` header.
# Keep this DIFFERENT from your WiFi password.
# Override via env var in production: export GARDEN_API_KEY="something-long"
API_KEY = os.environ.get("GARDEN_API_KEY", "garden-survailor-key-change-me")

# A node is considered "offline" if no reading arrived within this many seconds.
OFFLINE_AFTER_SECONDS = int(os.environ.get("GARDEN_OFFLINE_AFTER", "1800"))  # 30 min

# Password required to delete readings from the dashboard.
# Override via env var: export GARDEN_ADMIN_PASSWORD="something-better"
ADMIN_PASSWORD = os.environ.get("GARDEN_ADMIN_PASSWORD", "admin")

# Battery voltage range for a single-cell LiPo (used to compute % on the backend
# as a fallback / sanity reference; the firmware also sends its own estimate).
BATTERY_FULL_V = 4.20
BATTERY_EMPTY_V = 3.30

# SQLite database file (created next to this package).
DB_PATH = os.environ.get(
    "GARDEN_DB_PATH",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "garden.db"),
)
DATABASE_URL = f"sqlite:///{DB_PATH}"
