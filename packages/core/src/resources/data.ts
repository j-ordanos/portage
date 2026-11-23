export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongo"
  | "redis";

export interface DataMigrationSnippets {
  dump: string;
  restore: string;
  verify: string;
}

export function databaseMigrationSnippets(
  engine: DatabaseEngine | "other",
): DataMigrationSnippets {
  switch (engine) {
    case "postgres":
      return {
        dump: "pg_dump -Fc -h <source-host> -U <source-user> <source-db> > db.dump",
        restore:
          "pg_restore -h <target-host> -U <target-user> -d <target-db> --clean --if-exists db.dump",
        verify:
          "psql -h <target-host> -U <target-user> -d <target-db> -c 'SELECT count(*) FROM <table>;'",
      };
    case "mysql":
    case "mariadb":
      return {
        dump: "mysqldump --single-transaction -h <source-host> -u <source-user> -p <source-db> > db.sql",
        restore:
          "mysql -h <target-host> -u <target-user> -p <target-db> < db.sql",
        verify:
          "mysql -h <target-host> -u <target-user> -p -e 'SELECT COUNT(*) FROM <target-db>.<table>;'",
      };
    case "mongo":
      return {
        dump: "mongodump --uri='<source-uri>' --archive=db.archive",
        restore:
          "mongorestore --uri='<target-uri>' --archive=db.archive --drop",
        verify:
          "mongosh '<target-uri>' --eval 'db.getCollectionNames().length'",
      };
    case "redis":
      return {
        dump: "redis-cli -h <source-host> -a <source-password> BGSAVE",
        restore:
          "Copy dump.rdb to the stopped target data directory, then start Redis.",
        verify: "redis-cli -h <target-host> DBSIZE",
      };
    default:
      return {
        dump: "Use the source database vendor's native dump utility.",
        restore: "Use the target database vendor's native restore utility.",
        verify: "Verify the expected row counts or checksums manually.",
      };
  }
}

export function volumeMigrationSnippets(
  volumeName = "<source-volume>",
): DataMigrationSnippets {
  return {
    dump: `docker run --rm -v ${volumeName}:/data -v $PWD:/backup alpine tar czf /backup/vol.tgz -C /data .`,
    restore:
      "docker run --rm -v <target-volume>:/data -v $PWD:/backup alpine tar xzf /backup/vol.tgz -C /data",
    verify:
      "docker run --rm -v <target-volume>:/data alpine find /data -maxdepth 2 -type f | sort",
  };
}
