"""Pydantic request/response models."""
from typing import Optional

from pydantic import BaseModel, Field


class ReadingIn(BaseModel):
    """Payload the ESP32 POSTs to /api/readings."""

    node_id: str = Field(default="pot-1", max_length=64)
    moisture: float = Field(..., ge=0, le=100, description="Soil moisture %")
    moisture_raw: Optional[int] = Field(default=None, description="Raw ADC value")
    water_level: Optional[float] = Field(default=None, ge=0, le=100)
    battery_voltage: Optional[float] = Field(default=None, ge=0, le=10)
    battery_percent: Optional[float] = Field(default=None, ge=0, le=100)
    temperature: Optional[float] = Field(default=None, ge=-40, le=125)
    humidity: Optional[float] = Field(default=None, ge=0, le=100)


class NodeStatus(BaseModel):
    node_id: str
    online: bool
    last_seen: Optional[str]
    seconds_since: Optional[float]
    moisture: Optional[float]
    water_level: Optional[float]
    battery_voltage: Optional[float]
    battery_percent: Optional[float]
    temperature: Optional[float]
    humidity: Optional[float]
    battery_state: str  # "ok" | "low" | "empty" | "unknown"
