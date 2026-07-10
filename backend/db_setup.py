#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Database setup script for oasis.
Creates the SQLite database and videos table if they don't exist.
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
    conn.commit()
    conn.close()
    print(f'✅ 資料庫已初始化: {DB_PATH}')


def main():
    create_tables()


if __name__ == '__main__':
    main()
