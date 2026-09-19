import { CrmClient } from "../crm/crm.client";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import { AgentAction } from "./schemas";

export interface ActionExecutorContext {
  crm: CrmClient;
  logger: Logger;
  debug: DebugRecorder;
  phone: string;
  primaryFlatId: string | number | null;
}

export async function executeActions(
  actions: AgentAction[],
  ctx: ActionExecutorContext,
): Promise<string[]> {
  const executed: string[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "set_contact_type": {
        await ctx.crm.setContactType(ctx.phone, action.contactType);
        ctx.debug.recordCrmAction("set_contact_type", { phone: ctx.phone, contactType: action.contactType });
        ctx.logger.info({ contactType: action.contactType }, "action.set_contact_type");
        executed.push("set_contact_type");
        break;
      }
      case "update_deal_info": {
        await ctx.crm.updateDealInfo(ctx.phone, action.data);
        ctx.debug.recordCrmAction("update_deal_info", { phone: ctx.phone, data: action.data });
        ctx.logger.info("action.update_deal_info");
        executed.push("update_deal_info");
        break;
      }
      case "set_crm_status": {
        const flatId = action.flatId ?? ctx.primaryFlatId;
        if (flatId === null || flatId === undefined) {
          ctx.logger.error("action.set_crm_status.no_flat");
          break;
        }
        await ctx.crm.setStatus(flatId, action.status);
        ctx.debug.recordCrmAction("set_crm_status", { flatId, status: action.status });
        ctx.logger.info({ flatId, status: action.status }, "action.set_crm_status");
        executed.push("set_crm_status");
        break;
      }
    }
  }

  return executed;
}
