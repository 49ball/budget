INSERT INTO couples (id, created_at) VALUES ('couple-1', datetime('now'));

INSERT INTO members (id, couple_id, code, name, created_at)
VALUES ('member-jeongtae', 'couple-1', 'REPLACE_WITH_JEONGTAE_CODE', '정태', datetime('now'));

INSERT INTO members (id, couple_id, code, name, created_at)
VALUES ('member-minju', 'couple-1', 'REPLACE_WITH_MINJU_CODE', '민주', datetime('now'));
