-- noon-elo.7.2: rate_limits rows whose window has ended are pruned, a few at a time, by every hit (Db.take), or a
-- client minting fresh keys (one per address it can use) would grow the table without bound. `win` is the second the
-- key's window began (noon-elo.5.1; before that, the window's index), so "began over a day ago" (the longest window a
-- rule may have) finds the ended rows, oldest first, through this index.
create index rate_limits_win on rate_limits (win);
