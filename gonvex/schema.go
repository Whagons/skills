package backend

import "github.com/gonvex/gonvex/pkg/gonvex"

func Schema(s *gonvex.Schema) {
	s.TenantTable("skill_users", func(t *gonvex.Table) {
		t.ID("owner_id")
		t.String("email")
		t.String("name")
		t.Time("created_at")
		t.Time("updated_at")

		t.Index("by_email", "email")
	})

	s.TenantTable("skills", func(t *gonvex.Table) {
		t.ID("id")
		t.String("owner_id")
		t.String("name")
		t.String("summary")
		t.String("content")
		t.Time("created_at")
		t.Time("updated_at")

		t.Index("by_owner_name", "owner_id", "name")
		t.Index("by_owner_updated_at", "owner_id", "updated_at")
	})

	s.TenantTable("skill_api_keys", func(t *gonvex.Table) {
		t.ID("id")
		t.String("owner_id")
		t.String("name")
		t.String("key_hash")
		t.String("prefix")
		t.Time("created_at")
		t.Time("revoked_at")

		t.Index("by_key_hash", "key_hash")
		t.Index("by_owner_created_at", "owner_id", "created_at")
	})

	s.TenantTable("skill_sessions", func(t *gonvex.Table) {
		t.ID("id")
		t.String("owner_id")
		t.String("token_hash")
		t.Time("created_at")
		t.Time("expires_at")
		t.Time("revoked_at")

		t.Index("by_token_hash", "token_hash")
		t.Index("by_owner_token_hash", "owner_id", "token_hash")
	})

	s.TenantTable("skill_credentials", func(t *gonvex.Table) {
		t.ID("id")
		t.String("owner_id")
		t.String("name")
		t.String("summary")
		t.String("secret_value")
		t.Time("created_at")
		t.Time("updated_at")

		t.Index("by_owner_name", "owner_id", "name")
	})
}
