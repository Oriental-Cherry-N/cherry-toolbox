"""Read-only UI doubles: no WeChat process is accessed by these tests."""
import contextlib
import datetime
import importlib.util
import io
import json
import pathlib
import sys
import threading
import types
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / "python" / "wechat_auto_reply_worker.py"
spec = importlib.util.spec_from_file_location("passive_worker", source)
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)


class Control:
    def __init__(self, text="", items=None):
        self.text = text
        self.items = items or []

    def exists(self, **_):
        return True

    def window_text(self):
        return self.text

    def children(self, **_):
        return self.items

    def __getattr__(self, name):
        raise AssertionError(f"Unexpected UI operation: {name}")


class Message:
    element_info = types.SimpleNamespace(runtime_id=(1, 2, 3))

    def class_name(self):
        return "test::MessageBubble"

    def window_text(self):
        raise AssertionError("Message content must never be read")


class Window(Control):
    handle = 123

    def __init__(self):
        super().__init__("Fixture Contact")
        self.controls = {"name": Control(self.text), "history": Control(), "edit": Control(), "list": Control(items=[Message()])}

    def class_name(self):
        return "mmui::ChatSingleWindow"

    def child_window(self, kind):
        return self.controls[kind]


def environment(present=True):
    window = Window()
    return types.SimpleNamespace(
        Buttons=types.SimpleNamespace(ChatHistoryButton={"kind": "history"}),
        Texts=types.SimpleNamespace(CurrentChatNameText={"kind": "name"}),
        Lists=types.SimpleNamespace(FriendChatList={"kind": "list"}),
        Edits=types.SimpleNamespace(InputEdit={"kind": "edit"}),
        Tools=types.SimpleNamespace(is_group_chat=lambda _: False),
        desktop=types.SimpleNamespace(windows=lambda **_: [window] if present else [], window=lambda **_: window),
    )


def configuration():
    return worker.Configuration(
        allowlist=("Fixture Contact",), cooldown_minutes=30, daily_count=0,
        daily_limit=20, dry_run=True, last_reply_at_by_contact={},
        rate_date=datetime.date.today(), reply_text="unused",
    )


class PassiveWorkerTests(unittest.TestCase):
    def test_existing_window_is_observed_without_ui_mutations(self):
        ui = environment()
        watchers = worker.open_watchers(configuration(), ui, threading.Event())
        self.assertEqual(len(watchers), 1)
        self.assertEqual(watchers[0].last_runtime_id, (1, 2, 3))

    def test_missing_window_is_rejected_without_opening_it(self):
        with self.assertRaisesRegex(RuntimeError, "manually"):
            worker.open_watchers(configuration(), environment(False), threading.Event())

    def test_detected_event_contains_metadata_only(self):
        ui = environment()
        watcher = worker.open_watchers(configuration(), ui, threading.Event())[0]
        watcher.pending_runtime_id = (1, 2, 3)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            worker.process_pending_message(watcher, ui)
        event = json.loads(output.getvalue())
        self.assertEqual(set(event), {"type", "contact", "timestamp"})
        self.assertEqual(event["type"], "detected")


if __name__ == "__main__":
    unittest.main()
