// Used only to recognize the pre-migration schema. Names of constraints and
// their supporting indexes are intentionally ignored; definitions matter.
async function inspectBaseline(client, schema) {
  const columns = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_value
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid
     LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname COLLATE "C", a.attnum`, [schema]);
  const constraints = await client.query(
    `SELECT c.relname AS table_name, con.contype AS kind,
            pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname <> 'schema_migrations' AND con.contype IN ('p', 'u', 'f', 'c')
     ORDER BY c.relname COLLATE "C", con.contype, pg_get_constraintdef(con.oid) COLLATE "C"`, [schema]);
  const enums = await client.query(
    `SELECT t.typname AS type_name, e.enumlabel AS label
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = $1 ORDER BY t.typname COLLATE "C", e.enumsortorder`, [schema]);
  return { columns: columns.rows, constraints: constraints.rows, enums: enums.rows };
}

module.exports = { inspectBaseline };
