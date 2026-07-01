create table if not exists market_snapshots (
  id integer primary key autoincrement,
  player text not null,
  keyword text not null,
  card_name text not null,
  last_sale real,
  last_sale_date text,
  avg_7 real,
  avg_14 real,
  avg_30 real,
  sales_7 integer,
  sales_14 integer,
  sales_30 integer,
  market_signal text,
  recommendation text,
  response_json text not null,
  fetched_at text not null,
  cache_week text not null
);

create index if not exists idx_market_snapshots_keyword_fetched
  on market_snapshots (keyword, fetched_at desc);

create index if not exists idx_market_snapshots_player_fetched
  on market_snapshots (player, fetched_at desc);

create unique index if not exists idx_market_snapshots_keyword_week
  on market_snapshots (keyword, cache_week);
