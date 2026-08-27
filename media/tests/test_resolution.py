import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import anyio
import pytest

from media_service.resolution import (
    ResolutionCapacityError,
    ResolutionCoordinator,
    ResolutionCoordinatorClosedError,
    ResolutionExecutor,
    ResolutionTimeoutError,
)
from media_service.resolver import MediaResolveError


def test_executor_decodes_a_successful_one_shot_worker_response():
    async def scenario() -> None:
        envelope = json.dumps(
            {
                "ok": True,
                "result": {
                    "provider": "youtube",
                    "media_id": "dQw4w9WgXcQ",
                    "title": "Worker result",
                    "duration": 12.5,
                    "streams": [
                        {
                            "upstream_url": "https://media.googlevideo.com/file",
                            "upstream_headers": {"User-Agent": "worker"},
                            "format_id": "18",
                            "width": 640,
                            "height": 360,
                            "fps": 30.0,
                            "bitrate_kbps": 500.0,
                            "size_bytes": 1024,
                            "video_codec": "avc1",
                            "audio_codec": "mp4a",
                        }
                    ],
                },
            },
            separators=(",", ":"),
        )
        command = (
            sys.executable,
            "-c",
            f"import sys; sys.stdin.buffer.read(); sys.stdout.write({envelope!r})",
        )
        executor = ResolutionExecutor(max_workers=1, command=command)

        result = await executor.resolve(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        )

        assert result.title == "Worker result"
        assert result.streams[0].format_id == "18"
        assert result.streams[0].upstream_headers == {"User-Agent": "worker"}
        await executor.aclose()

    anyio.run(scenario)


def test_executor_cancellation_terminates_the_running_worker():
    async def scenario() -> None:
        command = (
            sys.executable,
            "-c",
            "import sys,time; sys.stdin.buffer.read(); time.sleep(60)",
        )
        executor = ResolutionExecutor(max_workers=1, command=command)
        resolving = asyncio.create_task(
            executor.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        )
        for _attempt in range(100):
            if executor._processes:
                break
            await asyncio.sleep(0.01)
        assert executor._processes
        process = next(iter(executor._processes))

        resolving.cancel()
        with pytest.raises(asyncio.CancelledError):
            await resolving

        assert process.returncode is not None
        assert not executor._processes
        await executor.aclose()

    anyio.run(scenario)


def test_repeated_cancellation_cannot_interrupt_process_reaping():
    async def scenario() -> None:
        command = (
            sys.executable,
            "-c",
            "import signal,sys,time; sys.stdin.buffer.read(); "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
        )
        executor = ResolutionExecutor(max_workers=1, command=command)
        resolving = asyncio.create_task(
            executor.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        )
        for _attempt in range(100):
            if executor._processes:
                break
            await asyncio.sleep(0.01)
        process = next(iter(executor._processes))
        await asyncio.sleep(0.05)

        resolving.cancel()
        await asyncio.sleep(0.05)
        resolving.cancel()
        with pytest.raises(asyncio.CancelledError):
            await resolving

        assert process.returncode is not None
        assert not executor._processes
        await executor.aclose()

    anyio.run(scenario)


def test_default_one_shot_worker_path_runs_without_contacting_upstream():
    async def scenario() -> None:
        executor = ResolutionExecutor(max_workers=1)

        with pytest.raises(MediaResolveError) as raised:
            await executor.resolve("https://attacker.example/not-youtube")

        assert raised.value.code == "resolve_failed"
        assert raised.value.public_message == "Unable to resolve media"
        assert not executor._processes
        await executor.aclose()

    anyio.run(scenario)


def test_close_waits_for_an_in_progress_spawn_and_reaps_the_result():
    async def scenario() -> None:
        original_spawn = asyncio.create_subprocess_exec
        spawn_started = asyncio.Event()
        release_spawn = asyncio.Event()

        async def delayed_spawn(*args, **kwargs):
            spawn_started.set()
            await release_spawn.wait()
            return await original_spawn(*args, **kwargs)

        executor = ResolutionExecutor(
            max_workers=1,
            command=(
                sys.executable,
                "-c",
                "import sys,time; sys.stdin.buffer.read(); time.sleep(60)",
            ),
        )
        with patch(
            "media_service.resolution.asyncio.create_subprocess_exec",
            delayed_spawn,
        ):
            resolving = asyncio.create_task(
                executor.resolve(
                    "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                )
            )
            await spawn_started.wait()
            closing = asyncio.create_task(executor.aclose())
            await asyncio.sleep(0)
            assert not closing.done()
            release_spawn.set()
            await closing
            with pytest.raises(asyncio.CancelledError):
                await resolving

        assert not executor._active_tasks
        assert not executor._processes

    anyio.run(scenario)


@pytest.mark.skipif(os.name != "posix", reason="process-group cleanup is POSIX-only")
def test_executor_cancellation_kills_a_signal_ignoring_grandchild():
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory, "grandchild.pid")
            child_code = (
                "import signal,time;"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
                "time.sleep(60)"
            )
            worker_code = (
                "import pathlib,subprocess,sys,time;"
                "sys.stdin.buffer.read();"
                f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}]);"
                "pathlib.Path(sys.argv[1]).write_text(str(child.pid));"
                "time.sleep(60)"
            )
            executor = ResolutionExecutor(
                max_workers=1,
                command=(sys.executable, "-c", worker_code, str(pid_file)),
            )
            resolving = asyncio.create_task(
                executor.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            )
            for _attempt in range(200):
                if pid_file.exists():
                    break
                await asyncio.sleep(0.01)
            assert pid_file.exists()
            grandchild_pid = int(pid_file.read_text())

            resolving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await resolving

            for _attempt in range(200):
                try:
                    os.kill(grandchild_pid, 0)
                except ProcessLookupError:
                    break
                await asyncio.sleep(0.01)
            else:
                pytest.fail("resolver grandchild survived process-group cleanup")
            await executor.aclose()

    anyio.run(scenario)


def test_worker_error_text_and_status_are_replaced_by_parent_allowlist():
    async def scenario() -> None:
        envelope = json.dumps(
            {
                "ok": False,
                "error": {
                    "code": "youtube_auth_required",
                    "public_message": "private cookie and proxy detail",
                    "status_code": 418,
                },
            },
            separators=(",", ":"),
        )
        command = (
            sys.executable,
            "-c",
            f"import sys; sys.stdin.buffer.read(); sys.stdout.write({envelope!r})",
        )
        executor = ResolutionExecutor(max_workers=1, command=command)

        with pytest.raises(MediaResolveError) as raised:
            await executor.resolve(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            )

        assert raised.value.code == "youtube_auth_required"
        assert raised.value.status_code == 502
        assert raised.value.public_message == (
            "YouTube authentication is required for this media"
        )
        assert "private" not in raised.value.public_message
        await executor.aclose()

    anyio.run(scenario)


def test_oversized_worker_output_is_rejected_and_reaped():
    async def scenario() -> None:
        command = (
            sys.executable,
            "-c",
            "import sys,time; sys.stdin.buffer.read(); "
            "sys.stdout.buffer.write(b'x' * (2 * 1024 * 1024 + 1)); "
            "sys.stdout.buffer.flush(); time.sleep(60)",
        )
        executor = ResolutionExecutor(max_workers=1, command=command)

        with pytest.raises(MediaResolveError) as raised:
            await executor.resolve(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            )

        assert raised.value.code == "resolve_unavailable"
        assert not executor._processes
        await executor.aclose()

    anyio.run(scenario)


def test_same_key_callers_share_one_flight_and_cancellation_is_isolated():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, object]()
        started = asyncio.Event()
        release = asyncio.Event()
        result = object()
        calls = 0
        duplicate_calls = 0

        async def operation() -> object:
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return result

        async def duplicate_operation() -> object:
            nonlocal duplicate_calls
            duplicate_calls += 1
            return object()

        cancelled_waiter = asyncio.create_task(
            coordinator.run("youtube:one", operation)
        )
        await started.wait()
        surviving_waiter = asyncio.create_task(
            coordinator.run("youtube:one", duplicate_operation)
        )
        await asyncio.sleep(0)

        cancelled_waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled_waiter
        assert not surviving_waiter.done()

        release.set()
        assert await surviving_waiter is result
        assert calls == 1
        assert duplicate_calls == 0
        await coordinator.aclose()

    anyio.run(scenario)


def test_different_keys_are_serialized_by_the_global_capacity_limit():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str](
            max_concurrent_resolutions=1,
        )
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        second_started = asyncio.Event()

        async def first_operation() -> str:
            first_started.set()
            await release_first.wait()
            return "first"

        async def second_operation() -> str:
            second_started.set()
            return "second"

        first = asyncio.create_task(coordinator.run("first", first_operation))
        await first_started.wait()
        second = asyncio.create_task(coordinator.run("second", second_operation))
        await asyncio.sleep(0.02)
        assert not second_started.is_set()

        release_first.set()
        assert await asyncio.gather(first, second) == ["first", "second"]
        assert second_started.is_set()
        await coordinator.aclose()

    anyio.run(scenario)


def test_distinct_resolution_flights_fail_fast_at_the_pending_limit():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str](
            max_concurrent_resolutions=1,
            max_pending_resolutions=1,
        )
        started = asyncio.Event()
        release = asyncio.Event()
        overflow_started = False

        async def occupied() -> str:
            started.set()
            await release.wait()
            return "occupied"

        async def overflow() -> str:
            nonlocal overflow_started
            overflow_started = True
            return "overflow"

        first = asyncio.create_task(coordinator.run("first", occupied))
        await started.wait()
        with pytest.raises(ResolutionCapacityError):
            await coordinator.run("second", overflow)
        assert overflow_started is False

        release.set()
        assert await first == "occupied"
        await coordinator.aclose()

    anyio.run(scenario)


def test_success_cache_ttl_and_force_refresh_replace_the_cached_value():
    async def scenario() -> None:
        now = [100.0]
        coordinator = ResolutionCoordinator[str, str](
            cache_ttl_seconds=10.0,
            clock=lambda: now[0],
        )
        calls = 0

        async def operation() -> str:
            nonlocal calls
            calls += 1
            return f"value-{calls}"

        assert await coordinator.run("media", operation) == "value-1"
        now[0] = 109.9
        assert await coordinator.run("media", operation) == "value-1"
        assert calls == 1

        assert await coordinator.run("media", operation, force=True) == "value-2"
        assert await coordinator.run("media", operation) == "value-2"
        assert calls == 2

        now[0] = 120.0
        assert await coordinator.run("media", operation) == "value-3"
        assert calls == 3
        await coordinator.aclose()

    anyio.run(scenario)


def test_force_joins_an_existing_same_key_flight_instead_of_duplicating_it():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str]()
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def operation() -> str:
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return "shared"

        first = asyncio.create_task(coordinator.run("media", operation))
        await started.wait()
        forced = asyncio.create_task(
            coordinator.run("media", operation, force=True)
        )
        await asyncio.sleep(0)
        release.set()

        assert await asyncio.gather(first, forced) == ["shared", "shared"]
        assert calls == 1
        await coordinator.aclose()

    anyio.run(scenario)


def test_timeout_cancels_the_owned_operation_and_is_not_cached():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str](timeout_seconds=0.03)
        cancelled = asyncio.Event()
        calls = 0

        async def slow_operation() -> str:
            nonlocal calls
            calls += 1
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.set()
            return "too-late"

        with pytest.raises(ResolutionTimeoutError):
            await coordinator.run("media", slow_operation)
        await asyncio.wait_for(cancelled.wait(), timeout=0.2)

        async def fast_operation() -> str:
            nonlocal calls
            calls += 1
            return "recovered"

        assert await coordinator.run("media", fast_operation) == "recovered"
        assert calls == 2
        await coordinator.aclose()

    anyio.run(scenario)


def test_timeout_budget_includes_waiting_for_global_capacity():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str](timeout_seconds=0.03)
        operation_started = False

        # Hold the same capacity primitive used by flights so this assertion is
        # independent of scheduling races between two equally timed flights.
        await coordinator._capacity.acquire()

        async def operation() -> str:
            nonlocal operation_started
            operation_started = True
            return "unexpected"

        try:
            with pytest.raises(ResolutionTimeoutError):
                await coordinator.run("queued", operation)
        finally:
            coordinator._capacity.release()

        assert operation_started is False
        await coordinator.aclose()

    anyio.run(scenario)


def test_lru_evicts_the_least_recently_used_completed_value():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str](max_cache_entries=2)
        calls: dict[str, int] = {}

        async def resolve(key: str) -> str:
            calls[key] = calls.get(key, 0) + 1
            return f"{key}-{calls[key]}"

        async def run(key: str) -> str:
            return await coordinator.run(key, lambda: resolve(key))

        assert await run("a") == "a-1"
        assert await run("b") == "b-1"
        assert await run("a") == "a-1"  # Touch A, making B the LRU entry.
        assert await run("c") == "c-1"
        assert await run("a") == "a-1"
        assert await run("b") == "b-2"
        assert calls == {"a": 1, "b": 2, "c": 1}
        await coordinator.aclose()

    anyio.run(scenario)


def test_operation_failure_is_shared_but_not_cached():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str]()
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def failing_operation() -> str:
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            raise ValueError("resolver failed")

        first = asyncio.create_task(coordinator.run("media", failing_operation))
        await started.wait()
        second = asyncio.create_task(coordinator.run("media", failing_operation))
        await asyncio.sleep(0)
        release.set()

        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(result, ValueError) for result in results)
        assert calls == 1

        async def recovered_operation() -> str:
            nonlocal calls
            calls += 1
            return "recovered"

        assert await coordinator.run("media", recovered_operation) == "recovered"
        assert calls == 2
        await coordinator.aclose()

    anyio.run(scenario)


def test_aclose_cancels_flights_clears_ownership_and_rejects_new_work():
    async def scenario() -> None:
        coordinator = ResolutionCoordinator[str, str]()
        started = asyncio.Event()
        operation_cancelled = asyncio.Event()

        async def operation() -> str:
            started.set()
            try:
                await asyncio.sleep(60)
            finally:
                operation_cancelled.set()
            return "never"

        waiter = asyncio.create_task(coordinator.run("media", operation))
        await started.wait()
        await coordinator.aclose()
        await asyncio.wait_for(operation_cancelled.wait(), timeout=0.2)

        with pytest.raises(ResolutionCoordinatorClosedError):
            await waiter
        with pytest.raises(ResolutionCoordinatorClosedError):
            await coordinator.run("other", operation)

        # Shutdown is deliberately idempotent for lifespan cleanup paths.
        await coordinator.aclose()

    anyio.run(scenario)


@pytest.mark.parametrize(
    ("option", "value"),
    [
        ("cache_ttl_seconds", 0),
        ("max_cache_entries", 0),
        ("max_concurrent_resolutions", 0),
        ("max_pending_resolutions", 0),
        ("timeout_seconds", 0),
    ],
)
def test_invalid_limits_are_rejected(option, value):
    with pytest.raises(ValueError):
        ResolutionCoordinator(**{option: value})


def test_pending_limit_cannot_be_smaller_than_running_capacity():
    with pytest.raises(ValueError):
        ResolutionCoordinator(
            max_concurrent_resolutions=2,
            max_pending_resolutions=1,
        )
