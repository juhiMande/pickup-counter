-- Runs once, when the Postgres volume is first created.
-- The app creates its own tables on startup; this only adds a separate DB for tests.
CREATE DATABASE pickup_test;
