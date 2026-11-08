-- A send some recipients refused was recorded but nobody was told. The row still holds only a reference.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('held_message','account_reconnect','send_failed','reminder_due','followup_due','rule_matched','gateway_downstream_changed','send_partial'));
