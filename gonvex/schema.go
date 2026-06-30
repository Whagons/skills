package backend

import "github.com/gonvex/gonvex/pkg/gonvex"

func Schema(s *gonvex.Schema) {
	s.TenantTable("skills", func(t *gonvex.Table) {
		t.ID("id")
		t.String("name")
		t.String("summary")
		t.String("content")
		t.Time("created_at")
		t.Time("updated_at")

		t.Index("by_name", "name")
		t.Index("by_updated_at", "updated_at")
	})

	s.TenantTable("skill_api_keys", func(t *gonvex.Table) {
		t.ID("id")
		t.String("name")
		t.String("key_hash")
		t.String("prefix")
		t.Time("created_at")
		t.Time("revoked_at")

		t.Index("by_key_hash", "key_hash")
	})

	s.TenantTable("skill_sessions", func(t *gonvex.Table) {
		t.ID("id")
		t.String("token_hash")
		t.Time("created_at")
		t.Time("expires_at")
		t.Time("revoked_at")

		t.Index("by_token_hash", "token_hash")
	})

	s.TenantTable("skill_credentials", func(t *gonvex.Table) {
		t.ID("id")
		t.String("name")
		t.String("summary")
		t.String("secret_value")
		t.Time("created_at")
		t.Time("updated_at")

		t.Index("by_name", "name")
	})
}
