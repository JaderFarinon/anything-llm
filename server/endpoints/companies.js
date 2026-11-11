const { Company } = require("../models/company");
const prisma = require("../utils/prisma");
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");

const adminOnly = [validatedRequest, flexUserRoleValid([ROLES.admin])];

function companyEndpoints(app) {
  if (!app) return;

  app.get("/admin/companies", adminOnly, async (_request, response) => {
    try {
      const companies = await Company.list();
      response.status(200).json({ companies });
    } catch (error) {
      console.error("Failed to list companies:", error.message);
      response.status(500).json({ error: "Não foi possível listar empresas." });
    }
  });

  app.get("/admin/companies/options", adminOnly, async (_request, response) => {
    try {
      const [users, workspaces] = await Promise.all([
        prisma.users.findMany({
          select: { id: true, username: true, role: true },
          orderBy: { username: "asc" },
        }),
        prisma.workspaces.findMany({
          select: { id: true, name: true, slug: true, companyId: true },
          orderBy: { name: "asc" },
        }),
      ]);
      response.status(200).json({ users, workspaces });
    } catch (error) {
      console.error("Failed to load company options:", error.message);
      response.status(500).json({ error: "Não foi possível carregar opções." });
    }
  });

  app.post("/admin/companies", adminOnly, async (request, response) => {
    try {
      const { name } = reqBody(request);
      const company = await Company.create(name);
      response.status(201).json({ company });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.put("/admin/companies/:id", adminOnly, async (request, response) => {
    try {
      const { name } = reqBody(request);
      const company = await Company.update(request.params.id, name);
      response.status(200).json({ company });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.put(
    "/admin/companies/:id/members",
    adminOnly,
    async (request, response) => {
      try {
        const { userIds } = reqBody(request);
        if (!Array.isArray(userIds))
          return response.status(400).json({ error: "userIds deve ser uma lista." });
        const company = await Company.setMembers(request.params.id, userIds);
        response.status(200).json({ company });
      } catch (error) {
        response.status(400).json({ error: error.message });
      }
    }
  );

  app.put(
    "/admin/companies/:id/workspaces/:workspaceId",
    adminOnly,
    async (request, response) => {
      try {
        const company = await Company.setWorkspace(
          request.params.id,
          request.params.workspaceId
        );
        response.status(200).json({ company });
      } catch (error) {
        response.status(400).json({ error: error.message });
      }
    }
  );

  app.delete(
    "/admin/companies/workspaces/:workspaceId",
    adminOnly,
    async (request, response) => {
      try {
        await Company.setWorkspace(null, request.params.workspaceId);
        response.status(200).json({ success: true });
      } catch (error) {
        response.status(400).json({ error: error.message });
      }
    }
  );
}

module.exports = { companyEndpoints };
