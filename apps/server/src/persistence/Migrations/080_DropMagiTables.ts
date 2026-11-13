import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Magi now runs as an agent skill outside T3 Code; fork databases still carry its former run store.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND (name GLOB 'magi_*' OR name GLOB 'projection_magi_*')
  `;
  yield* Effect.forEach(tables, ({ name }) => sql`DROP TABLE IF EXISTS ${sql(name)}`, {
    discard: true,
  });
});
