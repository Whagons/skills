package backend

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"

	"github.com/gonvex/gonvex/pkg/gonvex"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// Only the workspace owner changes published (global) skills. The owner's
// own API key publishes live; members can only propose new skills.
func TestOwnerPublishesWorkspaceSkills(t *testing.T) {
	dsn := os.Getenv("SKILLS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SKILLS_TEST_DATABASE_URL to an empty disposable PostgreSQL database")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	ensureTablesDone.Store(false)
	if err = ensureTables(ctx, db); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into skill_users(owner_id,email,name,can_own) values('pub-owner','pub-owner@example.com','Owner',true),('pub-member','pub-member@example.com','Member',false)`)
	exec(`insert into skill_sessions(id,owner_id,workspace_id,token_hash,expires_at) values('pub-owner','pub-owner','pub-owner',$1,now()+interval '1 day'),('pub-member','pub-member','pub-owner',$2,now()+interval '1 day')`, hashToken("pub-owner-token"), hashToken("pub-member-token"))
	exec(`insert into skill_workspace_members(id,workspace_owner_id,email,invited_by,role_id) values('pub-membership','pub-owner','pub-member@example.com','pub-owner','')`)
	q := &gonvex.QueryCtx{RuntimeContext: gonvex.RuntimeContext{Context: ctx, DB: db}}
	m := &gonvex.MutationCtx{RuntimeContext: gonvex.RuntimeContext{Context: ctx, DB: db}}
	writer, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "pub-owner-token", Role: AccessRole{Name: "Writer", Scopes: []string{scopeSkillsRead, scopeSkillsWrite}, AllSkills: true}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AssignAccessRole(m, AssignRoleArgs{SessionToken: "pub-owner-token", ID: "pub-membership", RoleID: writer.ID}); err != nil {
		t.Fatal(err)
	}
	ownerKey, err := CreateAPIKey(m, CreateAPIKeyArgs{SessionToken: "pub-owner-token", Name: "owner agent", Scopes: []string{scopeSkillsRead, scopeSkillsWrite}})
	if err != nil {
		t.Fatal(err)
	}
	memberKey, err := CreateAPIKey(m, CreateAPIKeyArgs{SessionToken: "pub-member-token", Name: "member agent", Scopes: []string{scopeSkillsRead, scopeSkillsWrite}})
	if err != nil {
		t.Fatal(err)
	}
	live := func(key string) map[string]string {
		t.Helper()
		rows, err := AgentListSkills(q, AgentSkillArgs{APIKey: key})
		if err != nil {
			t.Fatal(err)
		}
		names := map[string]string{}
		for _, row := range rows {
			skill, err := AgentGetSkill(q, AgentSkillArgs{APIKey: key, ID: row.ID})
			if err != nil {
				t.Fatal(err)
			}
			names[skill.Name] = skill.Content
		}
		return names
	}
	upload := func(key, name, content string, publish bool) (Skill, error) {
		return AgentUploadSkill(m, AgentSaveSkillArgs{APIKey: key, Name: name, Content: content, Publish: publish})
	}

	published, err := upload(ownerKey.APIKey, "pub-deploy", "v1", true)
	if err != nil || !published.Approved {
		t.Fatalf("owner publish = %+v, %v; want live", published, err)
	}
	if got := live(memberKey.APIKey)["pub-deploy"]; got != "v1" {
		t.Fatalf("members do not see the published skill: %q", got)
	}
	if updated, err := upload(ownerKey.APIKey, "pub-deploy", "v2", true); err != nil || !updated.Approved || updated.ID != published.ID {
		t.Fatalf("owner update = %+v, %v; want the same live row", updated, err)
	}

	t.Run("members cannot change or remove a published skill", func(t *testing.T) {
		for _, publish := range []bool{false, true} {
			if _, err := upload(memberKey.APIKey, "pub-deploy", "member edit", publish); !errors.Is(err, errOwnerOnlySkillChange) {
				t.Fatalf("member upload (publish=%v) error = %v", publish, err)
			}
		}
		if _, err := SaveSkill(m, SaveSkillArgs{SessionToken: "pub-member-token", Name: "PUB-DEPLOY", Content: "ui edit"}); !errors.Is(err, errOwnerOnlySkillChange) {
			t.Fatalf("member UI save error = %v", err)
		}
		if _, err := AgentDeleteSkill(m, AgentSkillArgs{APIKey: memberKey.APIKey, ID: published.ID}); !errors.Is(err, errOwnerOnlySkillChange) {
			t.Fatalf("member agent delete error = %v", err)
		}
		if _, err := DeleteSkill(m, DeleteSkillArgs{SessionToken: "pub-member-token", ID: published.ID}); !errors.Is(err, errOwnerOnlySkillChange) {
			t.Fatalf("member UI delete error = %v", err)
		}
		if got := live(ownerKey.APIKey)["pub-deploy"]; got != "v2" {
			t.Fatalf("published content changed to %q", got)
		}
	})

	t.Run("member proposals stay pending until the owner publishes", func(t *testing.T) {
		proposal, err := upload(memberKey.APIKey, "pub-proposal", "idea", true)
		if err != nil || proposal.Approved {
			t.Fatalf("member proposal = %+v, %v; want pending", proposal, err)
		}
		if _, err := upload(memberKey.APIKey, "pub-proposal", "idea v2", false); err != nil {
			t.Fatalf("member cannot revise a pending proposal: %v", err)
		}
		if _, ok := live(ownerKey.APIKey)["pub-proposal"]; ok {
			t.Fatal("pending proposal is served to agents")
		}
		final, err := upload(ownerKey.APIKey, "pub-proposal", "idea, edited by owner", true)
		if err != nil || !final.Approved || final.ID != proposal.ID {
			t.Fatalf("owner publish of proposal = %+v, %v", final, err)
		}
	})

	t.Run("an owner upload without publish stays pending like older CLIs", func(t *testing.T) {
		legacy, err := upload(ownerKey.APIKey, "pub-legacy", "draft", false)
		if err != nil || legacy.Approved {
			t.Fatalf("legacy owner upload = %+v, %v; want pending", legacy, err)
		}
	})

	t.Run("the owner deletes", func(t *testing.T) {
		if result, err := AgentDeleteSkill(m, AgentSkillArgs{APIKey: ownerKey.APIKey, ID: published.ID}); err != nil || !result.Deleted {
			t.Fatalf("owner delete = %+v, %v", result, err)
		}
		if _, ok := live(ownerKey.APIKey)["pub-deploy"]; ok {
			t.Fatal("deleted skill still served")
		}
	})

}
