from media_service.sessions import RelaySessionStore, RelayStreamKey, RelayTarget


def test_sessions_expire_and_oldest_entry_is_evicted_at_capacity():
    now = 100.0

    def clock() -> float:
        return now

    store = RelaySessionStore(ttl_seconds=10, max_sessions=2, clock=clock)
    first = store.create(RelayTarget("https://media.googlevideo.com/first"))
    second = store.create(RelayTarget("https://media.googlevideo.com/second"))
    third = store.create(RelayTarget("https://media.googlevideo.com/third"))

    assert store.get(first) is None
    assert store.get(second) is not None
    assert store.get(third) is not None

    now = 110.0
    assert store.get(second) is None
    assert store.get(third) is None


def test_access_renews_the_session_idle_deadline():
    now = 0.0

    def clock() -> float:
        return now

    store = RelaySessionStore(ttl_seconds=10, clock=clock)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    now = 9.0
    assert store.get(session) is not None
    now = 18.0
    assert store.get(session) is not None
    now = 28.0
    assert store.get(session) is None


def test_cached_target_invalidation_is_compare_and_delete_and_refreshes_all_sessions():
    store = RelaySessionStore()
    key = RelayStreamKey("video-id", "18")
    source_url = "https://www.youtube.com/watch?v=video-id"
    stale = RelayTarget(
        "https://media.googlevideo.com/stale",
        media_id=key.media_id,
        format_id=key.format_id,
        source_url=source_url,
    )
    concurrently_refreshed = RelayTarget(
        "https://media.googlevideo.com/concurrent",
        media_id=key.media_id,
        format_id=key.format_id,
        source_url=source_url,
    )
    final = RelayTarget(
        "https://media.googlevideo.com/final",
        media_id=key.media_id,
        format_id=key.format_id,
        source_url=source_url,
    )
    first_session = store.create(stale)
    second_session = store.create(stale)

    assert store.get_cached_target(key) == stale
    assert store.invalidate_target(key, expected=concurrently_refreshed) is False
    assert store.get_cached_target(key) == stale

    assert store.invalidate_target(key, expected=stale) is True
    assert store.get_cached_target(key) is None
    assert store.compare_and_store_target(final, expected=None) == final

    assert store.get_cached_target(key) == final
    assert store.get(first_session) == final
    assert store.get(second_session) == final


def test_cached_target_is_removed_when_its_last_session_expires():
    now = 0.0

    def clock() -> float:
        return now

    store = RelaySessionStore(ttl_seconds=10, clock=clock)
    target = RelayTarget(
        "https://media.googlevideo.com/video",
        media_id="video-id",
        format_id="18",
        source_url="https://www.youtube.com/watch?v=video-id",
    )
    key = RelayStreamKey("video-id", "18")
    first_session = store.create(target)
    second_session = store.create(target)

    now = 10.0
    assert store.get(first_session) is None
    assert store.get_cached_target(key) == target
    assert store.get(second_session) is None
    assert store.get_cached_target(key) is None


def test_slow_refresh_cannot_overwrite_a_newer_resolve_generation():
    store = RelaySessionStore()
    source_url = "https://www.youtube.com/watch?v=video-id"
    stale = RelayTarget(
        "https://media.googlevideo.com/stale",
        media_id="video-id",
        format_id="18",
        source_url=source_url,
    )
    refreshed_stale = RelayTarget(
        "https://media.googlevideo.com/refreshed-stale",
        media_id="video-id",
        format_id="18",
        source_url=source_url,
    )
    newer = RelayTarget(
        "https://media.googlevideo.com/newer-resolve",
        media_id="video-id",
        format_id="18",
        source_url=source_url,
    )
    stale_session = store.create(stale)
    newer_session = store.create(newer)

    assert store.compare_and_store_target(
        refreshed_stale,
        expected=stale,
    ) == newer
    assert stale.cache_key is not None
    assert store.get_cached_target(stale.cache_key) == newer
    assert store.get(stale_session) == newer
    assert store.get(newer_session) == newer


def test_missing_cache_can_be_restored_only_if_it_remains_missing():
    store = RelaySessionStore()
    target = RelayTarget(
        "https://media.googlevideo.com/stale",
        media_id="video-id",
        format_id="18",
        source_url="https://www.youtube.com/watch?v=video-id",
    )
    replacement = RelayTarget(
        "https://media.googlevideo.com/replacement",
        media_id="video-id",
        format_id="18",
        source_url="https://www.youtube.com/watch?v=video-id",
    )
    store.create(target)
    assert target.cache_key is not None
    assert store.invalidate_target(target.cache_key, expected=target) is True

    assert store.compare_and_store_target(replacement, expected=None) == replacement
    assert store.get_cached_target(target.cache_key) == replacement
