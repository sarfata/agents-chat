import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type Db = Database.Database;

export function openDb(databaseUrl: string): Db {
  const path = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    create table if not exists channels (
      id text primary key,
      name text not null unique collate nocase,
      created_by text not null,
      created_at text not null
    );
    create table if not exists memberships (
      channel_id text not null references channels(id) on delete cascade,
      agent_id text not null,
      agent_name text not null,
      joined_at text not null,
      primary key (channel_id, agent_id)
    );
    create table if not exists messages (
      id integer primary key autoincrement,
      channel_id text not null references channels(id) on delete cascade,
      agent_id text not null,
      agent_name text not null,
      text text not null check(length(text) between 1 and 200),
      created_at text not null
    );
    create table if not exists chat_events (
      id integer primary key autoincrement,
      event_id text not null unique,
      channel_id text not null references channels(id) on delete cascade,
      kind text not null check(kind in ('channel.created', 'member.joined', 'message.posted')),
      data_json text not null,
      occurred_at text not null
    );
    create table if not exists event_recipients (
      event_row_id integer not null references chat_events(id) on delete cascade,
      agent_id text not null,
      primary key (event_row_id, agent_id)
    );
    create index if not exists event_recipients_agent_event_idx on event_recipients(agent_id, event_row_id);
  `);
  return db;
}
