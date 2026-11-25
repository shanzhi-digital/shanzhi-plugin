# Third-party notices

The database adapters and configuration helpers in `vendor/` derive from [STARDUSTLC666/dsh-sql](https://github.com/STARDUSTLC666/dsh-sql), version 0.5.9, Copyright (c) 2026 stardustlc, MIT licensed. The original copyright and permission notice are preserved in [LICENSE](./LICENSE).

These files, the SQL parser policy, freshness helpers and management schema checks were copied from the local `dsh-datasource` customization. The question-set plugin owns its runtime copies and does not import or call the data-source plugin. Local changes reject EXPLAIN answer queries and limit queries to a fixed source and enabled catalog tables. Existing database read-only transaction and relation verification behavior is retained.

The question store, credential reader, query service and tests are local additions. The dependencies `mysql2`, `pg` and `node-sql-parser` retain their own package licenses.
