-- E6.2 (F19): the seq of the newest snapshot in MinIO. S3 cannot list in reverse (learning-tests/minio), so
-- the latest one is found here, not by listing. Written only AFTER the object is stored, so it never names a
-- missing snapshot, and it only moves forward. `content`/`seq` (F8's idle save) are no longer written: they
-- stay as what a document saved before E6.2 opens from until its first snapshot.
alter table documents add column snapshot_seq bigint not null default 0 check (snapshot_seq >= 0);
