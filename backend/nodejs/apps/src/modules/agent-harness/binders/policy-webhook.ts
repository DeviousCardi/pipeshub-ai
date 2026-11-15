import { ConfigPolicyWebhookSettings } from '../application/policy-webhook-settings';
import { HarnessBinder } from './context';
import { AGENT_HARNESS_POLICY_WEBHOOK } from './tokens';

/**
 * G-40: each org's external policy webhook, over the encrypted KV documents
 * the deployment passes (`policyWebhook`); without them the admin routes
 * answer 503.
 */
export const bindPolicyWebhook: HarnessBinder = ({
  container,
  dependencies,
  controlPlane,
}) => {
  const documents = dependencies.policyWebhook;
  if (
    documents === undefined ||
    container.isBound(AGENT_HARNESS_POLICY_WEBHOOK)
  ) {
    return;
  }
  container
    .bind<ConfigPolicyWebhookSettings>(AGENT_HARNESS_POLICY_WEBHOOK)
    .toConstantValue(
      new ConfigPolicyWebhookSettings(
        documents.settings,
        documents.legacy,
        controlPlane,
      ),
    );
};
