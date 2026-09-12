"""Low-intrusion WeChat auto-reply worker for Cherry Toolbox.

Only fixed, independent windows for explicitly allowlisted contacts are polled.
Incoming message text is never printed, returned to Electron, or persisted.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any


MAX_ALLOWLIST_ENTRIES = 10
MAX_CONTACT_NAME_LENGTH = 128
MAX_REPLY_TEXT_LENGTH = 2000
MAX_COOLDOWN_MINUTES = 24 * 60
MAX_DAILY_LIMIT = 100
MESSAGE_STABILITY_SECONDS = 0.75
POLL_SECONDS = 0.25


@dataclass(frozen=True)
class Configuration:
    allowlist: tuple[str, ...]
    cooldown_minutes: int
    daily_count: int
    daily_limit: int
    dry_run: bool
    last_reply_at_by_contact: dict[str, float]
    rate_date: dt.date
    reply_text: str


@dataclass
class Watcher:
    contact: str
    dialog_window: Any
    chat_list: Any
    input_edit: Any
    last_runtime_id: object | None
    pending_runtime_id: object | None = None
    pending_since: float | None = None
    settle_until: float = 0.0


@dataclass(frozen=True)
class UiDependencies:
    Buttons: Any
    Edits: Any
    Lists: Any
    Texts: Any
    Tools: Any
    desktop: Any
    win32gui: Any


def emit(event_type: str, **values: object) -> None:
    payload = {"type": event_type, **values}
    # ASCII-only JSON also works in legacy GBK consoles; Electron decodes it
    # back to the original Unicode contact name.
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def utc_timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def require_integer(value: object, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be a whole number.")
    if value < 1 or value > maximum:
        raise ValueError(f"{label} must be from 1 to {maximum}.")
    return value


def load_rate_state(
    value: object, allowlist: tuple[str, ...]
) -> tuple[int, dt.date, dict[str, float]]:
    if not isinstance(value, dict):
        raise ValueError("The persisted rate-limit state must be an object.")
    daily_count = value.get("dailyCount")
    if (
        isinstance(daily_count, bool)
        or not isinstance(daily_count, int)
        or daily_count < 0
        or daily_count > MAX_DAILY_LIMIT
    ):
        raise ValueError("The persisted daily reply count is invalid.")
    raw_date = value.get("date")
    if not isinstance(raw_date, str):
        raise ValueError("The persisted rate-limit date is invalid.")
    try:
        rate_date = dt.date.fromisoformat(raw_date)
    except ValueError as error:
        raise ValueError("The persisted rate-limit date is invalid.") from error

    raw_timestamps = value.get("lastReplyAtByContact")
    if not isinstance(raw_timestamps, dict):
        raise ValueError("The persisted cooldown state must be an object.")
    if len(raw_timestamps) > MAX_ALLOWLIST_ENTRIES:
        raise ValueError("The persisted cooldown state has too many contacts.")
    timestamps: dict[str, float] = {}
    for contact, raw_timestamp in raw_timestamps.items():
        if contact not in allowlist or not isinstance(raw_timestamp, str):
            raise ValueError("The persisted cooldown state is invalid.")
        try:
            parsed = dt.datetime.fromisoformat(raw_timestamp)
        except ValueError as error:
            raise ValueError("A persisted cooldown timestamp is invalid.") from error
        if parsed.tzinfo is None:
            raise ValueError("A persisted cooldown timestamp needs a timezone.")
        timestamps[contact] = parsed.timestamp()
    return daily_count, rate_date, timestamps


def load_configuration() -> Configuration:
    raw = sys.stdin.readline()
    if not raw:
        raise ValueError("The worker did not receive a configuration.")
    value: Any = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("The worker configuration must be an object.")

    raw_allowlist = value.get("allowlist")
    raw_reply = value.get("replyText")
    dry_run = value.get("dryRun")
    if not isinstance(raw_allowlist, list):
        raise ValueError("The allowlist must be a list.")
    if not isinstance(raw_reply, str) or not raw_reply.strip():
        raise ValueError("The reply message cannot be empty.")
    if dry_run is not True:
        raise ValueError("Dry-run mode is mandatory; live sending is disabled.")

    contacts: list[str] = []
    for candidate in raw_allowlist:
        if not isinstance(candidate, str):
            raise ValueError("Every allowlist entry must be a contact name.")
        contact = candidate.strip()
        if not contact:
            continue
        if len(contact) > MAX_CONTACT_NAME_LENGTH:
            raise ValueError("An allowlist contact name is too long.")
        if contact not in contacts:
            contacts.append(contact)
    if not contacts:
        raise ValueError("The allowlist cannot be empty.")
    if len(contacts) > MAX_ALLOWLIST_ENTRIES:
        raise ValueError(
            f"The allowlist is limited to {MAX_ALLOWLIST_ENTRIES} contacts."
        )

    reply_text = raw_reply.strip()
    if len(reply_text) > MAX_REPLY_TEXT_LENGTH:
        raise ValueError("The reply message exceeds the configured text limit.")

    allowlist = tuple(contacts)
    daily_count, rate_date, last_reply_at_by_contact = load_rate_state(
        value.get("rateState"), allowlist
    )
    return Configuration(
        allowlist=allowlist,
        cooldown_minutes=require_integer(
            value.get("cooldownMinutes"),
            "The per-contact cooldown",
            MAX_COOLDOWN_MINUTES,
        ),
        daily_count=daily_count,
        daily_limit=require_integer(
            value.get("dailyLimit"), "The daily reply limit", MAX_DAILY_LIMIT
        ),
        dry_run=dry_run,
        last_reply_at_by_contact=last_reply_at_by_contact,
        rate_date=rate_date,
        reply_text=reply_text,
    )


def load_ui_dependencies() -> UiDependencies:
    # pyweixin can print diagnostics during import. Keep stdout JSON-only.
    with contextlib.redirect_stdout(sys.stderr):
        from pyweixin import Tools
        from pyweixin.Uielements import Buttons, Edits, Lists, Texts
        from pywinauto import Desktop
        import pyautogui
        import win32gui

    # Upstream disables this globally; re-enable the emergency mouse-corner stop.
    pyautogui.FAILSAFE = True
    return UiDependencies(
        Buttons=Buttons,
        Edits=Edits,
        Lists=Lists,
        Texts=Texts,
        Tools=Tools,
        desktop=Desktop(backend="uia"),
        win32gui=win32gui,
    )


def runtime_id(item: Any) -> object:
    value = item.element_info.runtime_id
    if value is None:
        raise RuntimeError("WeChat did not expose a stable message identifier.")
    try:
        return tuple(value)
    except TypeError:
        return value


def latest_message(watcher: Watcher) -> Any | None:
    messages = watcher.chat_list.children(control_type="ListItem")
    return messages[-1] if messages else None


def is_replyable_message(item: Any) -> bool:
    # pyweixin uses ChatItemView for timestamps and system notices. Every other
    # ListItem in the chat list is a selectable message bubble (text, voice,
    # image, video, file, link, card, sticker, transfer, and so on).
    return item.class_name() != "mmui::ChatItemView"


def verify_private_contact_view(
    window: Any, contact: str, ui: UiDependencies
) -> None:
    current_name = window.child_window(**ui.Texts.CurrentChatNameText)
    if not current_name.exists(timeout=0.5):
        raise RuntimeError(
            f'Unable to verify the current chat name for "{contact}".'
        )
    if current_name.window_text().strip() != contact:
        raise RuntimeError(f'The current chat no longer matches "{contact}".')
    if ui.Tools.is_group_chat(window):
        raise RuntimeError(
            f'"{contact}" is a group chat; only private contacts are allowed.'
        )
    chat_history_button = window.child_window(**ui.Buttons.ChatHistoryButton)
    if not chat_history_button.exists(timeout=0.2):
        raise RuntimeError(
            f'"{contact}" could not be verified as a saved private contact.'
        )


def find_independent_contact_window(
    contact: str, ui: UiDependencies, timeout: float
) -> Any | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for window in ui.desktop.windows(
            class_name="mmui::ChatSingleWindow", top_level_only=True
        ):
            try:
                specification = ui.desktop.window(handle=window.handle)
                if window.window_text().strip() == contact:
                    return specification
                current_name = specification.child_window(
                    **ui.Texts.CurrentChatNameText
                )
                if (
                    current_name.exists(timeout=0.1)
                    and current_name.window_text().strip() == contact
                ):
                    return specification
            except Exception:
                continue
        time.sleep(0.1)
    return None


def verify_exact_private_contact(watcher: Watcher, ui: UiDependencies) -> None:
    if not watcher.dialog_window.exists(timeout=0.2):
        raise RuntimeError(f'The fixed window for "{watcher.contact}" disappeared.')
    if watcher.dialog_window.class_name() != "mmui::ChatSingleWindow":
        raise RuntimeError(
            f'The fixed window type no longer matches "{watcher.contact}".'
        )
    verify_private_contact_view(watcher.dialog_window, watcher.contact, ui)


def bind_watcher_without_focus(watcher: Watcher, ui: UiDependencies) -> None:
    verify_exact_private_contact(watcher, ui)
    if not watcher.chat_list.exists(timeout=0.5):
        raise RuntimeError(
            f'Unable to bind the message list for "{watcher.contact}".'
        )
    if not watcher.input_edit.exists(timeout=0.5):
        raise RuntimeError(
            f'Unable to bind the reply field for "{watcher.contact}".'
        )
    latest = latest_message(watcher)
    watcher.last_runtime_id = runtime_id(latest) if latest is not None else None


def open_watchers(
    configuration: Configuration,
    ui: UiDependencies,
    stop_event: threading.Event,
) -> list[Watcher]:
    watchers: list[Watcher] = []
    for contact in configuration.allowlist:
        if stop_event.is_set():
            break
        dialog_window = find_independent_contact_window(contact, ui, timeout=0.2)
        if dialog_window is None:
            raise RuntimeError(f'Open the private chat window for "{contact}" manually before starting detection.')
        watcher = Watcher(
            contact=contact,
            dialog_window=dialog_window,
            chat_list=dialog_window.child_window(**ui.Lists.FriendChatList),
            input_edit=dialog_window.child_window(**ui.Edits.InputEdit),
            last_runtime_id=None,
        )
        bind_watcher_without_focus(watcher, ui)
        watchers.append(watcher)
    if not watchers and not stop_event.is_set():
        raise RuntimeError("No existing allowlisted contact window could be observed.")
    return watchers


def process_pending_message(
    watcher: Watcher,
    ui: UiDependencies,
) -> None:
    latest = latest_message(watcher)
    if latest is None:
        watcher.pending_runtime_id = None
        watcher.pending_since = None
        return
    latest_id = runtime_id(latest)
    if latest_id != watcher.pending_runtime_id:
        watcher.last_runtime_id = latest_id
        watcher.pending_runtime_id = latest_id
        watcher.pending_since = time.monotonic()
        return

    watcher.pending_runtime_id = None
    watcher.pending_since = None
    if not is_replyable_message(latest):
        emit(
            "skipped",
            contact=watcher.contact,
            reason="system-message",
            timestamp=utc_timestamp(),
        )
        return

    # Passive UIA reads only: never open, focus, minimize, restore, or type.
    verify_exact_private_contact(watcher, ui)
    watcher.last_runtime_id = runtime_id(latest)
    emit("detected", contact=watcher.contact, timestamp=utc_timestamp())


def listen_for_stop(stop_event: threading.Event) -> None:
    try:
        for line in sys.stdin:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("type") == "stop":
                stop_event.set()
                return
    finally:
        stop_event.set()


def monitor(
    watchers: list[Watcher],
    ui: UiDependencies,
    stop_event: threading.Event,
) -> None:
    emit("ready")
    while not stop_event.wait(POLL_SECONDS):
        now = time.monotonic()
        for watcher in watchers:
            if stop_event.is_set():
                return
            latest = latest_message(watcher)
            if latest is None:
                continue
            latest_id = runtime_id(latest)
            if now < watcher.settle_until:
                watcher.last_runtime_id = latest_id
                watcher.pending_runtime_id = None
                watcher.pending_since = None
                continue
            if watcher.last_runtime_id is None:
                watcher.last_runtime_id = latest_id
                continue
            if latest_id != watcher.last_runtime_id:
                watcher.last_runtime_id = latest_id
                watcher.pending_runtime_id = latest_id
                watcher.pending_since = now
                continue
            if (
                watcher.pending_runtime_id is not None
                and watcher.pending_since is not None
                and now - watcher.pending_since >= MESSAGE_STABILITY_SECONDS
            ):
                process_pending_message(watcher, ui)


def run() -> int:
    watchers: list[Watcher] = []
    stop_event = threading.Event()
    ui: UiDependencies | None = None
    try:
        configuration = load_configuration()
        ui = load_ui_dependencies()
        control_thread = threading.Thread(
            target=listen_for_stop,
            args=(stop_event,),
            daemon=True,
            name="wechat-worker-control",
        )
        control_thread.start()
        watchers = open_watchers(configuration, ui, stop_event)
        if not stop_event.is_set():
            monitor(watchers, ui, stop_event)
        emit("stopped")
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        emit("error", message=f"Low-intrusion WeChat worker stopped: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
