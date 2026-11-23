const slugify = require("slugify");
const prisma = require("../utils/prisma");

const Company = {
  async list() {
    return await prisma.companies.findMany({
      orderBy: { name: "asc" },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, role: true } },
          },
        },
        workspaces: { select: { id: true, name: true, slug: true } },
        google_drive_connections: {
          select: {
            id: true,
            googleEmail: true,
            lastSyncAt: true,
            lastError: true,
          },
        },
      },
    });
  },

  async get(id) {
    return await prisma.companies.findUnique({ where: { id: Number(id) } });
  },

  async create(name) {
    const normalizedName = String(name || "").trim();
    if (normalizedName.length < 2 || normalizedName.length > 100)
      throw new Error("O nome da empresa deve ter de 2 a 100 caracteres.");

    const baseSlug =
      slugify(normalizedName, { lower: true, strict: true }) || "empresa";
    let slug = baseSlug;
    for (
      let suffix = 2;
      await prisma.companies.findUnique({ where: { slug } });
      suffix++
    )
      slug = `${baseSlug}-${suffix}`;

    return await prisma.companies.create({
      data: { name: normalizedName, slug },
    });
  },

  async update(id, name) {
    const normalizedName = String(name || "").trim();
    if (normalizedName.length < 2 || normalizedName.length > 100)
      throw new Error("O nome da empresa deve ter de 2 a 100 caracteres.");
    return await prisma.companies.update({
      where: { id: Number(id) },
      data: { name: normalizedName, lastUpdatedAt: new Date() },
    });
  },

  async setMembers(id, userIds = []) {
    const companyId = Number(id);
    const company = await prisma.companies.findUnique({
      where: { id: companyId },
      include: { members: true, workspaces: { select: { id: true } } },
    });
    if (!company) throw new Error("Empresa não encontrada.");

    const ids = [...new Set(userIds.map(Number).filter(Number.isInteger))];
    const existingUsers = await prisma.users.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existingUsers.length !== ids.length)
      throw new Error("Um ou mais usuários selecionados não existem.");

    await prisma.$transaction(async (tx) => {
      await tx.user_companies.deleteMany({ where: { companyId } });
      for (const userId of ids)
        await tx.user_companies.create({ data: { userId, companyId } });
      for (const workspace of company.workspaces) {
        await tx.workspace_users.deleteMany({
          where: {
            workspace_id: workspace.id,
            ...(ids.length ? { user_id: { notIn: ids } } : {}),
          },
        });
        for (const user_id of ids) {
          const exists = await tx.workspace_users.findFirst({
            where: { user_id, workspace_id: workspace.id },
          });
          if (!exists)
            await tx.workspace_users.create({
              data: { user_id, workspace_id: workspace.id },
            });
        }
      }
    });
    return await this.getWithDetails(companyId);
  },

  async setWorkspace(id, workspaceId) {
    const companyId = Number(id);
    const nextCompany = companyId
      ? await prisma.companies.findUnique({ where: { id: companyId } })
      : null;
    if (companyId && !nextCompany) throw new Error("Empresa não encontrada.");
    const workspace = await prisma.workspaces.findUnique({
      where: { id: Number(workspaceId) },
      select: { id: true, companyId: true },
    });
    if (!workspace) throw new Error("Workspace não encontrado.");
    const currentCompanyId = workspace.companyId;

    const companyFolders = await prisma.google_drive_folders.count({
      where: { workspaceId: workspace.id, scope: "company" },
    });
    if (companyFolders && currentCompanyId !== companyId)
      throw new Error(
        "Remova ou mova as pastas do Google Drive antes de alterar a empresa deste workspace."
      );

    const oldMembers = currentCompanyId
      ? await prisma.user_companies.findMany({
          where: { companyId: currentCompanyId },
          select: { userId: true },
        })
      : [];
    const newMembers = companyId
      ? await prisma.user_companies.findMany({
          where: { companyId },
          select: { userId: true },
        })
      : [];
    const newMemberIds = newMembers.map(({ userId }) => userId);
    const removedIds = oldMembers
      .map(({ userId }) => userId)
      .filter((userId) => !newMemberIds.includes(userId));

    await prisma.$transaction(async (tx) => {
      await tx.workspaces.update({
        where: { id: workspace.id },
        data: { companyId: companyId || null },
      });
      if (!companyId && removedIds.length)
        await tx.workspace_users.deleteMany({
          where: { workspace_id: workspace.id, user_id: { in: removedIds } },
        });
      if (companyId)
        await tx.workspace_users.deleteMany({
          where: {
            workspace_id: workspace.id,
            ...(newMemberIds.length
              ? { user_id: { notIn: newMemberIds } }
              : {}),
          },
        });
      for (const user_id of newMemberIds) {
        const exists = await tx.workspace_users.findFirst({
          where: { user_id, workspace_id: workspace.id },
        });
        if (!exists)
          await tx.workspace_users.create({
            data: { user_id, workspace_id: workspace.id },
          });
      }
    });
    return await this.getWithDetails(companyId);
  },

  async getWithDetails(id) {
    if (!id) return null;
    return await prisma.companies.findUnique({
      where: { id: Number(id) },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, role: true } },
          },
        },
        workspaces: { select: { id: true, name: true, slug: true } },
        google_drive_connections: {
          select: {
            id: true,
            googleEmail: true,
            lastSyncAt: true,
            lastError: true,
          },
        },
      },
    });
  },
};

module.exports = { Company };
