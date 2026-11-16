const { z } = require('zod');
const status = z.enum(['pending', 'in_progress', 'completed', 'closed', 'Closed']);
module.exports = {
  register: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(100),
    role: z.enum(['admin', 'supervisor', 'gate', 'store', 'user']).optional().default('gate'),
    secretKey: z.string().optional(),
    adminSecretKey: z.string().optional(),
  }),
  login: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }),
  refresh: z.object({ refreshToken: z.string().min(10) }),
  password: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(100) }),
  scan: z.object({
    lotNumber: z.string().trim().min(1).max(100),
    materialName: z.string().trim().max(150).optional(),
    status,
    note: z.string().trim().max(500).optional(),
    scanStage: z.enum(['GATE_INWARD', 'GATE_OUT', 'GATE_IN', 'STORE_INWARD', 'SUPERVISOR_PICKUP', 'SUPERVISOR_INWARD']).optional(),
    docType: z.enum(['PO', 'RGP', 'LOT']).optional(),
  }),
  createUser: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(6).max(100).optional(),
    role: z.enum(['admin', 'supervisor', 'gate', 'store', 'user']).default('supervisor'),
    secretKey: z.string().optional(),
    adminSecretKey: z.string().optional(),
  }),
  role: z.object({ role: z.enum(['admin', 'supervisor', 'gate', 'store', 'user']) }),
  active: z.object({ isActive: z.boolean() }),
  status,
};
