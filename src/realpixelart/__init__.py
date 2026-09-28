"""Public API. No file is written by pixelize()."""
from .config import Config
from .tools import export_png, save_result
from .pipeline import PixelizeResult, pixelize
from .sampling import ColorResult, process_colors, palette_catalog

__all__ = ["Config", "PixelizeResult", "pixelize", "save_result", "export_png",
           "ColorResult", "process_colors", "palette_catalog"]
__version__ = "0.1.0"
