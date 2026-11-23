import type { DokployClient } from "../clients/dokploy.js";
import type { Step } from "../plan/types.js";
import type { Vault } from "../vault.js";

export interface IdMapStore {
  get(
    runId: string,
    srcId: string,
    srcKind: string,
  ): Promise<{ targetId: string; created: boolean } | undefined>;
  put(
    runId: string,
    srcId: string,
    srcKind: string,
    targetId: string,
    created: boolean,
  ): Promise<void>;
}

export interface ApplyContext {
  runId: string;
  dokploy: DokployClient;
  vault: Vault;
  idMap: IdMapStore;
}

export async function executeStep(
  step: Step,
  ctx: ApplyContext,
): Promise<{
  targetId?: string;
  created?: boolean;
  note?: string;
}> {
  const existing = await ctx.idMap.get(ctx.runId, step.srcId, step.kind);
  if (existing) {
    return { targetId: existing.targetId, created: existing.created };
  }

  switch (step.kind) {
    case "CREATE_PROJECT": {
      const name =
        typeof step.payload.name === "string"
          ? step.payload.name
          : "Migrated project";
      const created = await ctx.dokploy.projectCreate({
        name,
        ...(typeof step.payload.description === "string"
          ? { description: step.payload.description }
          : {}),
      });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "project",
        created.projectId,
        true,
      );
      return { targetId: created.projectId, created: true };
    }
    case "ENSURE_ENVIRONMENT": {
      const projectId =
        typeof step.payload.projectId === "string"
          ? step.payload.projectId
          : undefined;
      if (!projectId) throw new Error("Environment step requires projectId");
      const name =
        typeof step.payload.name === "string"
          ? step.payload.name
          : "production";
      const created = await ctx.dokploy.environmentCreate({ name, projectId });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "environment",
        created.environmentId,
        true,
      );
      return { targetId: created.environmentId, created: true };
    }
    case "CREATE_APPLICATION": {
      const environmentId =
        typeof step.payload.environmentId === "string"
          ? step.payload.environmentId
          : undefined;
      if (!environmentId)
        throw new Error("Application step requires environmentId");
      const name =
        typeof step.payload.name === "string"
          ? step.payload.name
          : "Migrated app";
      const appName =
        typeof step.payload.appName === "string" ? step.payload.appName : name;
      const created = await ctx.dokploy.applicationCreate({
        name,
        environmentId,
        appName,
      });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "application",
        created.applicationId,
        true,
      );
      return { targetId: created.applicationId, created: true };
    }
    case "CREATE_COMPOSE": {
      const environmentId =
        typeof step.payload.environmentId === "string"
          ? step.payload.environmentId
          : undefined;
      if (!environmentId)
        throw new Error("Compose step requires environmentId");
      const name =
        typeof step.payload.name === "string"
          ? step.payload.name
          : "Migrated compose";
      const created = await ctx.dokploy.composeCreate({
        name,
        environmentId,
      });
      const composeFile =
        typeof step.payload.composeFile === "string"
          ? step.payload.composeFile
          : "";
      await ctx.dokploy.composeUpdate({
        composeId: created.composeId,
        composeFile,
        env: "",
      });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "compose",
        created.composeId,
        true,
      );
      return { targetId: created.composeId, created: true };
    }
    case "CREATE_DATABASE": {
      const environmentId =
        typeof step.payload.environmentId === "string"
          ? step.payload.environmentId
          : undefined;
      if (!environmentId)
        throw new Error("Database step requires environmentId");
      const engine =
        typeof step.payload.engine === "string" &&
        ["postgres", "mysql", "mariadb", "mongo", "redis"].includes(
          step.payload.engine,
        )
          ? (step.payload.engine as
              | "postgres"
              | "mysql"
              | "mariadb"
              | "mongo"
              | "redis")
          : undefined;
      if (!engine) throw new Error("Unsupported database engine");
      const name =
        typeof step.payload.name === "string"
          ? step.payload.name
          : "Migrated database";
      const passwordRef = step.vaultRefs[0];
      const password = passwordRef
        ? await ctx.vault.get(passwordRef)
        : undefined;
      const created = await ctx.dokploy.databaseCreate({
        engine,
        name,
        environmentId,
        ...(typeof step.payload.databaseName === "string"
          ? { databaseName: step.payload.databaseName }
          : {}),
        ...(typeof step.payload.databaseUser === "string"
          ? { databaseUser: step.payload.databaseUser }
          : {}),
        ...(password ? { databasePassword: password } : {}),
        ...(typeof step.payload.image === "string"
          ? { dockerImage: step.payload.image }
          : {}),
      });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "database",
        created.databaseId,
        true,
      );
      return { targetId: created.databaseId, created: true };
    }
    case "CREATE_MOUNT": {
      const serviceId =
        typeof step.payload.serviceId === "string"
          ? step.payload.serviceId
          : undefined;
      if (!serviceId) throw new Error("Mount step requires serviceId");
      const mountType =
        typeof step.payload.type === "string" &&
        ["bind", "volume", "file"].includes(step.payload.type)
          ? (step.payload.type as "bind" | "volume" | "file")
          : undefined;
      const mountPath =
        typeof step.payload.mountPath === "string"
          ? step.payload.mountPath
          : undefined;
      if (!mountType || !mountPath)
        throw new Error("Mount step has invalid type or path");
      const created = await ctx.dokploy.mountCreate({
        type: mountType,
        mountPath,
        serviceId,
        serviceType:
          typeof step.payload.serviceType === "string" &&
          step.payload.serviceType === "compose"
            ? "compose"
            : "application",
        ...(typeof step.payload.hostPath === "string"
          ? { hostPath: step.payload.hostPath }
          : {}),
        ...(typeof step.payload.volumeName === "string"
          ? { volumeName: step.payload.volumeName }
          : {}),
      });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "mount",
        created.mountId,
        true,
      );
      return { targetId: created.mountId, created: true };
    }
    case "SET_ENV": {
      const applicationId =
        typeof step.payload.applicationId === "string"
          ? step.payload.applicationId
          : undefined;
      if (!applicationId)
        throw new Error("Set environment step requires applicationId");
      const lines: string[] = [];
      for (const ref of step.vaultRefs) {
        const value = await ctx.vault.get(ref);
        const key =
          typeof step.payload.keys === "object" &&
          Array.isArray(step.payload.keys)
            ? (step.payload.keys.shift() as string | undefined)
            : undefined;
        if (key) lines.push(`${key}=${value}`);
      }
      await ctx.dokploy.applicationSaveEnvironment({
        applicationId,
        env: lines.join("\n"),
      });
      return { targetId: applicationId, created: false };
    }
    case "CREATE_DOMAIN": {
      const applicationId =
        typeof step.payload.applicationId === "string"
          ? step.payload.applicationId
          : undefined;
      if (!applicationId) throw new Error("Domain step requires applicationId");
      const host =
        typeof step.payload.host === "string" ? step.payload.host : "";
      const created = await ctx.dokploy.domainCreate({
        host,
        applicationId,
        ...(typeof step.payload.port === "number"
          ? { port: step.payload.port }
          : {}),
        ...(typeof step.payload.https === "boolean"
          ? { https: step.payload.https }
          : {}),
      });
      await ctx.idMap.put(
        ctx.runId,
        step.srcId,
        "domain",
        created.domainId,
        true,
      );
      return { targetId: created.domainId, created: true };
    }
    default:
      return { note: "Step is not implemented in the CP6 application subset" };
  }
}
