-- At most one ACTIVE model version per workspace and modality, enforced by the
-- database so concurrent activations cannot both succeed.
CREATE UNIQUE INDEX "ModelVersion_active_per_modality"
  ON "ModelVersion" ("workspaceId", "modality")
  WHERE "stage" = 'ACTIVE';
