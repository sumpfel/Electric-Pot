"""SQLAlchemy database setup and the Reading model."""
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Float, Integer, String, create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={
        "check_same_thread": False,  # needed for SQLite + threads
        "timeout": 15,               # wait up to 15s for a lock instead of failing
    },
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    """Make concurrent reads+writes robust so a busy DB never drops a reading."""
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")   # readers don't block the writer
    cur.execute("PRAGMA busy_timeout=15000") # 15s before raising "database is locked"
    cur.execute("PRAGMA synchronous=NORMAL") # safe with WAL, much faster
    cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Reading(Base):
    """A single measurement uploaded by an ESP32 node."""

    __tablename__ = "readings"

    id = Column(Integer, primary_key=True, index=True)
    # Which device sent this (lets you run several pots later).
    node_id = Column(String, index=True, nullable=False, default="pot-1")
    created_at = Column(DateTime, default=_utcnow, index=True, nullable=False)

    # Soil moisture as a percentage 0..100 (0 = bone dry, 100 = soaked).
    moisture = Column(Float, nullable=False)
    # Raw ADC value from the moisture sensor (useful for calibration/debugging).
    moisture_raw = Column(Integer, nullable=True)

    # Optional extra water-level / reservoir sensor (0..100). NULL if not wired.
    water_level = Column(Float, nullable=True)

    # Battery state.
    battery_voltage = Column(Float, nullable=True)   # volts, e.g. 3.91
    battery_percent = Column(Float, nullable=True)   # 0..100

    # Optional environment extras (e.g. from a DHT22 temp+humidity sensor).
    temperature = Column(Float, nullable=True)       # °C
    humidity = Column(Float, nullable=True)          # air relative humidity %

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "node_id": self.node_id,
            "created_at": self.created_at.replace(tzinfo=timezone.utc).isoformat()
            if self.created_at
            else None,
            "moisture": self.moisture,
            "moisture_raw": self.moisture_raw,
            "water_level": self.water_level,
            "battery_voltage": self.battery_voltage,
            "battery_percent": self.battery_percent,
            "temperature": self.temperature,
            "humidity": self.humidity,
        }


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_add_columns()


def _migrate_add_columns() -> None:
    """Add columns introduced after a DB was first created (simple SQLite migration).

    SQLAlchemy's create_all() only creates missing *tables*, not missing columns,
    so we add any new optional columns by hand if they don't exist yet.
    """
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    existing = {c["name"] for c in inspector.get_columns("readings")}
    wanted = {
        "humidity": "ALTER TABLE readings ADD COLUMN humidity FLOAT",
    }
    with engine.begin() as conn:
        for col, ddl in wanted.items():
            if col not in existing:
                conn.execute(text(ddl))
