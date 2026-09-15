from .audio import AudioEngine
from .base import Engine
from .cctv import CCTVEngine
from .document import DocumentEngine
from .drone import DroneEngine
from .email import EmailEngine
from .image import ImageEngine
from .invoice import InvoiceEngine

ENGINES: dict[str, Engine] = {
    engine.name: engine
    for engine in (
        DocumentEngine(),
        InvoiceEngine(),
        EmailEngine(),
        AudioEngine(),
        ImageEngine(),
        CCTVEngine(),
        DroneEngine(),
    )
}

__all__ = ["ENGINES", "Engine"]
