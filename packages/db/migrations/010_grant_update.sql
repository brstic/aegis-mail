-- Owners can change a grant's send permission in place.
GRANT UPDATE (can_send) ON mailbox_grants TO aegis_app;
CREATE POLICY app_change ON mailbox_grants FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND app.owns_account(account_id)) WITH CHECK (tenant_id = app.tenant_id() AND app.owns_account(account_id));
