"""Garden Survailor — FastAPI backend.

Receives moisture/battery readings from ESP32-C3 nodes over HTTP and serves a
dashboard with live charts.
"""
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import config
from .database import Reading, SessionLocal, init_db
from .schemas import NodeStatus, ReadingIn


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Garden Survailor", version="1.0.0", lifespan=lifespan)

_BASE = os.path.dirname(__file__)
app.mount("/static", StaticFiles(directory=os.path.join(_BASE, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(_BASE, "templates"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    if x_api_key != config.API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def _battery_state(voltage: Optional[float], percent: Optional[float]) -> str:
    """Classify battery health from voltage (preferred) or percent."""
    if voltage is None and percent is None:
        return "unknown"
    if voltage is not None:
        if voltage <= config.BATTERY_EMPTY_V + 0.05:
            return "empty"
        if voltage <= config.BATTERY_EMPTY_V + 0.25:
            return "low"
        return "ok"
    # fall back to percent
    if percent <= 5:
        return "empty"
    if percent <= 20:
        return "low"
    return "ok"


# --------------------------------------------------------------------------
# Ingest API (called by the ESP32)
# --------------------------------------------------------------------------
@app.post("/api/readings", status_code=201, dependencies=[Depends(require_api_key)])
def create_reading(payload: ReadingIn, db: Session = Depends(get_db)) -> dict:
    reading = Reading(
        node_id=payload.node_id,
        moisture=payload.moisture,
        moisture_raw=payload.moisture_raw,
        water_level=payload.water_level,
        battery_voltage=payload.battery_voltage,
        battery_percent=payload.battery_percent,
        temperature=payload.temperature,
        humidity=payload.humidity,
    )
    db.add(reading)
    try:
        db.commit()
    except Exception as exc:  # e.g. transient "database is locked"
        db.rollback()
        # 503 tells the client it's temporary; the ESP32 just retries next cycle.
        raise HTTPException(status_code=503, detail=f"DB write failed: {exc}")
    db.refresh(reading)
    return {"status": "ok", "id": reading.id}


# --------------------------------------------------------------------------
# Read API (called by the dashboard)
# --------------------------------------------------------------------------
@app.get("/api/readings")
def list_readings(
    node_id: Optional[str] = None,
    hours: int = 24,
    limit: int = 5000,
    db: Session = Depends(get_db),
) -> List[dict]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = db.query(Reading).filter(Reading.created_at >= since)
    if node_id:
        q = q.filter(Reading.node_id == node_id)
    rows = q.order_by(Reading.created_at.asc()).limit(limit).all()
    return [r.as_dict() for r in rows]


@app.delete("/api/readings")
def delete_readings(
    payload: dict,
    node_id: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict:
    """Delete readings. Requires the admin password in the JSON body.

    Body: {"password": "...", "node_id": "pot-1" | null}
    If node_id is given (query or body), only that node's readings are deleted;
    otherwise ALL readings are wiped.
    """
    if payload.get("password") != config.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="Wrong admin password")

    target = node_id or payload.get("node_id")
    q = db.query(Reading)
    if target:
        q = q.filter(Reading.node_id == target)
    deleted = q.delete(synchronize_session=False)
    db.commit()
    return {"status": "ok", "deleted": deleted, "node_id": target}


@app.get("/api/nodes", response_model=List[NodeStatus])
def list_nodes(db: Session = Depends(get_db)) -> List[NodeStatus]:
    # Latest reading per node.
    node_ids = [row[0] for row in db.query(Reading.node_id).distinct().all()]
    now = datetime.now(timezone.utc)
    out: List[NodeStatus] = []
    for nid in node_ids:
        last = (
            db.query(Reading)
            .filter(Reading.node_id == nid)
            .order_by(Reading.created_at.desc())
            .first()
        )
        if last is None:
            continue
        last_dt = last.created_at.replace(tzinfo=timezone.utc)
        secs = (now - last_dt).total_seconds()
        online = secs <= config.OFFLINE_AFTER_SECONDS
        out.append(
            NodeStatus(
                node_id=nid,
                online=online,
                last_seen=last_dt.isoformat(),
                seconds_since=secs,
                moisture=last.moisture,
                water_level=last.water_level,
                battery_voltage=last.battery_voltage,
                battery_percent=last.battery_percent,
                temperature=last.temperature,
                humidity=last.humidity,
                battery_state=_battery_state(last.battery_voltage, last.battery_percent),
            )
        )
    return out


@app.get("/api/stats")
def stats(node_id: Optional[str] = None, hours: int = 24, db: Session = Depends(get_db)) -> dict:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = db.query(
        func.avg(Reading.moisture),
        func.min(Reading.moisture),
        func.max(Reading.moisture),
        func.count(Reading.id),
    ).filter(Reading.created_at >= since)
    if node_id:
        q = q.filter(Reading.node_id == node_id)
    avg_m, min_m, max_m, count = q.one()
    return {
        "hours": hours,
        "count": count or 0,
        "moisture_avg": round(avg_m, 1) if avg_m is not None else None,
        "moisture_min": min_m,
        "moisture_max": max_m,
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    return templates.TemplateResponse(request, "index.html")
