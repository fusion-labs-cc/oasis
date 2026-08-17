#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Database setup for oasis.
create_tables() is called by the API on startup to create the SQLite database
and videos table if they don't exist (safe to call repeatedly).
"""

import os
import sqlite3

PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.environ.get('DB_PATH') or os.path.join(PROJECT_ROOT, 'oasis.db')


def create_tables():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS videos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            code        TEXT NOT NULL UNIQUE,
            url         TEXT NOT NULL,
            title       TEXT NOT NULL,
            title_zh_tw TEXT,
            actress     TEXT,
            tags        TEXT,
            cover       TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_videos_actress ON videos (actress)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_videos_code ON videos (code)")
    # Add video_path column if it doesn't exist (safe migration)
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN video_path TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # Add play_count column if it doesn't exist (safe migration)
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN play_count INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # Add download_pending column if it doesn't exist (safe migration).
    # Marks a video whose download was requested but hasn't completed, so a
    # server restart can re-queue it instead of silently dropping it.
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN download_pending INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # Cache the actual cover image bytes, not just its origin URL. `cover` still
    # holds the source URL (kept for editing/re-fetching); cover_image is the
    # image itself so a dead or hotlink-protected origin never blanks a cover,
    # and cover_type is its MIME so it can be served with the right Content-Type.
    # Populated lazily on first view (see /api/stream/cover). Safe migration.
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN cover_image BLOB")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN cover_type TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # User-defined groupings (an anime season, a multi-part release). `name` is
    # UNIQUE so "create this series" is naturally idempotent — re-analysing a
    # season joins the existing series instead of growing a second one with the
    # same name. No FOREIGN KEY: SQLite only enforces them when every connection
    # sets PRAGMA foreign_keys=ON, which this codebase does not, so relying on it
    # would be a guarantee in name only. delete_series() clears members itself.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS series (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    # A video belongs to at most one series; `episode` orders it within that
    # series. Both NULL for everything that predates this, which reads as
    # "unclassified" everywhere. Safe migrations.
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN series_id INTEGER")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN episode INTEGER")
    except sqlite3.OperationalError:
        pass  # Column already exists
    conn.execute("CREATE INDEX IF NOT EXISTS idx_videos_series ON videos (series_id)")

    # Series cover support: optional origin cover URL, cached image BLOB, and MIME type.
    try:
        conn.execute("ALTER TABLE series ADD COLUMN cover TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE series ADD COLUMN cover_image BLOB")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE series ADD COLUMN cover_type TEXT")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()
    print(f'✅ 資料庫已初始化: {DB_PATH}')
