"""Namespaced prompt-manager implementation bundled with the unified node."""

from .nodes import PromptManager
from .api import register

__all__ = ["PromptManager", "register"]
