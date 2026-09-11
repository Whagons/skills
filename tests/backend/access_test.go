package backend

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/gonvex/gonvex/pkg/gonvex"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestRoleGrants(t *testing.T) {
	r := AccessRole{Scopes: []string{scopeSkillsRead}, SkillIDs: []string{"allowed"}}
	if !r.allows(scopeSkillsRead, "allowed") || r.allows(scopeSkillsRead, "other") || r.allows(scopeSkillsWrite, "allowed") || r.allows(scopeSkillsRead, "") {
		t.Fatal("selected resource policy failed")
	}
	r.AllSkills = true
	if !r.allows(scopeSkillsRead, "future") || r.allows(scopeSkillsWrite, "future") {
		t.Fatal("all-resource policy bypassed operation permission")
	}
}

// Run only against a disposable database. The caller creates and removes it.
func TestAccessIntegration(t *testing.T) {
	dsn := os.Getenv("SKILLS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SKILLS_TEST_DATABASE_URL to an empty disposable PostgreSQL database")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	context := context.Background()
	ensureTablesDone.Store(false)
	if err = ensureTables(context, db); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(context, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into skill_users(owner_id,email,name) values('owner','owner@example.com','Owner'),('member','member@example.com','Member'),('other','other@example.com','Other'),('guest','guest@example.com','Guest')`)
	for _, id := range []string{"owner", "member", "other", "guest"} {
		workspace := id
		if id == "member" {
			workspace = "owner"
		}
		exec(`insert into skill_sessions(id,owner_id,workspace_id,token_hash,expires_at) values($1,$1,$2,$3,now()+interval '1 day')`, id, workspace, hashToken(id+"-token"))
	}
	exec(`insert into skill_workspace_members(id,workspace_owner_id,email) values('membership','owner','member@example.com')`)
	// Gonvex adds new columns as nullable when a table already contains rows.
	exec(`alter table skill_workspace_members alter column role_id drop not null`)
	exec(`update skill_workspace_members set role_id=null`)
	ensureTablesDone.Store(false)
	if err = ensureTables(context, db); err != nil {
		t.Fatal("nullable schema migration", err)
	}
	var legacyRole string
	if err = db.QueryRow(`select role_id from skill_workspace_members where id='membership'`).Scan(&legacyRole); err != nil || legacyRole != "" {
		t.Fatal("legacy access was not backfilled", err)
	}
	exec(`insert into skills(id,owner_id,name,content,approved_at) values('allowed','owner','allowed-skill','allowed content',now()),('forbidden','owner','forbidden-skill','private content',now()),('foreign','other','foreign-skill','foreign content',now())`)
	exec(`insert into skill_credentials(id,owner_id,name,secret_value) values('secret-allowed','owner','allowed-secret','test-secret'),('secret-forbidden','owner','forbidden-secret','private-secret')`)
	q := &gonvex.QueryCtx{RuntimeContext: gonvex.RuntimeContext{Context: context, DB: db, Env: map[string]string{"SKILLS_SECRET_KEY": strings.Repeat("01", 32)}}}
	m := &gonvex.MutationCtx{RuntimeContext: gonvex.RuntimeContext{Context: context, DB: db, Env: map[string]string{"SKILLS_SECRET_KEY": strings.Repeat("01", 32)}}}
	role, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "owner-token", Role: AccessRole{Name: "Limited", Scopes: []string{scopeSkillsRead, scopeSkillsWrite, scopeCredentialsRead}, SkillIDs: []string{"allowed"}, CredentialIDs: []string{"secret-allowed"}}})
	if err != nil {
		t.Fatal(err)
	}
	// Existing keys inherit changes to their creator's membership.
	key, err := CreateAPIKey(m, CreateAPIKeyArgs{SessionToken: "member-token", Name: "Before restriction", Scopes: []string{scopeSkillsRead, scopeSkillsWrite, scopeCredentialsRead}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AssignAccessRole(m, AssignRoleArgs{SessionToken: "owner-token", ID: "membership", RoleID: role.ID}); err != nil {
		t.Fatal(err)
	}
	t.Run("fresh permission snapshot reflects assignment and role edits", func(t *testing.T) {
		a := &gonvex.ActionCtx{RuntimeContext: q.RuntimeContext}
		owner, err := AccessSnapshot(a, SessionArgs{SessionToken: "owner-token"})
		if err != nil {
			t.Fatal(err)
		}
		state := owner["state"].(AccessState)
		if state.Assignments["membership"] != role.ID {
			t.Fatal("assignment missing from owner snapshot")
		}
		updated := role
		updated.SkillIDs = []string{"forbidden"}
		updated.CredentialIDs = []string{}
		if _, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "owner-token", Role: updated}); err != nil {
			t.Fatal(err)
		}
		member, err := AccessSnapshot(a, SessionArgs{SessionToken: "member-token"})
		if err != nil {
			t.Fatal(err)
		}
		vault := member["vault"].(map[string]any)
		skills := vault["skills"].([]map[string]any)
		if len(skills) != 1 || skills[0]["id"] != "forbidden" || len(vault["credentials"].([]map[string]any)) != 0 {
			t.Fatal("role edits not reflected or credentials leaked")
		}
		if len(member["state"].(AccessState).Roles) != 0 {
			t.Fatal("member received owner role roster")
		}
		if _, err := AccessSnapshot(a, SessionArgs{SessionToken: "invalid-token"}); err == nil {
			t.Fatal("invalid session accepted")
		}
		if _, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "owner-token", Role: role}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("filtered lists and snapshot", func(t *testing.T) {
		skills, err := ListSkills(q, SessionArgs{SessionToken: "member-token"})
		if err != nil || len(skills) != 1 || skills[0].ID != "allowed" {
			t.Fatalf("skills not filtered: %v", err)
		}
		credentials, err := ListCredentials(q, SessionArgs{SessionToken: "member-token"})
		if err != nil || len(credentials) != 1 || credentials[0].ID != "secret-allowed" {
			t.Fatalf("credentials not filtered: %v", err)
		}
		snapshot, err := AccessVault(q, SessionArgs{SessionToken: "member-token"})
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot["skills"].([]map[string]any)) != 1 || len(snapshot["credentials"].([]map[string]any)) != 1 {
			t.Fatal("snapshot leaks resources")
		}
	})
	t.Run("ID and name lookups for browser and CLI", func(t *testing.T) {
		for _, agent := range []bool{false, true} {
			token := "member-token"
			if agent {
				token = key.APIKey
			}
			for _, scope := range []string{scopeSkillsRead, scopeCredentialsRead} {
				id, name, badID, badName := "allowed", "allowed-skill", "forbidden", "forbidden-skill"
				if scope == scopeCredentialsRead {
					id, name, badID, badName = "secret-allowed", "allowed-secret", "secret-forbidden", "forbidden-secret"
				}
				for _, selector := range [][2]string{{id, ""}, {"", name}} {
					if err := requireAccess(context, db, token, agent, scope, selector[0], selector[1]); err != nil {
						t.Fatal(err)
					}
				}
				for _, selector := range [][2]string{{badID, ""}, {"", badName}, {id, badName}, {"foreign", ""}, {"", "new-item"}} {
					if err := requireAccess(context, db, token, agent, scope, selector[0], selector[1]); err == nil {
						t.Fatalf("unauthorized selector accepted: %v", selector)
					}
				}
			}
		}
		if _, err := GetSkill(q, GetSkillArgs{SessionToken: "member-token", Name: "forbidden-skill"}); err == nil {
			t.Fatal("browser content leak")
		}
		if _, err := AgentGetSkill(q, AgentSkillArgs{APIKey: key.APIKey, Name: "forbidden-skill"}); err == nil {
			t.Fatal("CLI content leak")
		}
		if _, err := GetCredential(m, GetCredentialArgs{SessionToken: "member-token", ID: "secret-forbidden"}); err == nil {
			t.Fatal("browser secret leak")
		}
		if _, err := AgentGetCredential(q, AgentSkillArgs{APIKey: key.APIKey, Name: "forbidden-secret"}); err == nil {
			t.Fatal("CLI secret leak")
		}
	})
	t.Run("allowed operations and personal key lifecycle", func(t *testing.T) {
		credential, err := GetCredential(m, GetCredentialArgs{SessionToken: "member-token", Name: "allowed-secret"})
		if err != nil || credential.ID != "secret-allowed" || credential.Value != "test-secret" {
			t.Fatal("allowed credential unavailable", err)
		}
		if _, err := SaveSkill(m, SaveSkillArgs{SessionToken: "member-token", ID: "allowed", Name: "allowed-skill", Content: "updated allowed content"}); err != nil {
			t.Fatal(err)
		}
		keys, err := ListAPIKeys(q, SessionArgs{SessionToken: "member-token"})
		if err != nil || len(keys) != 1 || !keys[0].CanRevoke {
			t.Fatal("member cannot manage personal key", err)
		}
		personal, err := CreateAPIKey(m, CreateAPIKeyArgs{SessionToken: "member-token", Scopes: []string{scopeSkillsRead}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := RevokeAPIKey(m, RevokeAPIKeyArgs{SessionToken: "member-token", ID: personal.Record.ID}); err != nil {
			t.Fatal("cannot revoke own key", err)
		}
		ownerKey, err := CreateAPIKey(m, CreateAPIKeyArgs{SessionToken: "owner-token", Scopes: []string{scopeSkillsRead}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := RevokeAPIKey(m, RevokeAPIKeyArgs{SessionToken: "member-token", ID: ownerKey.Record.ID}); err == nil {
			t.Fatal("member revoked owner key")
		}
		empty, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "owner-token", Role: AccessRole{Name: "Unused"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DeleteAccessRole(m, RemoveMemberArgs{SessionToken: "owner-token", ID: empty.ID}); err != nil {
			t.Fatal("cannot delete unused role", err)
		}
	})
	t.Run("no write or privilege escalation", func(t *testing.T) {
		if _, err := DeleteSkill(m, DeleteSkillArgs{SessionToken: "member-token", ID: "forbidden"}); err == nil {
			t.Fatal("forbidden delete")
		}
		if _, err := AgentUploadSkill(m, AgentSaveSkillArgs{APIKey: key.APIKey, Name: "new-item", Content: "new"}); err == nil {
			t.Fatal("selected role created new item")
		}
		if _, err := CreateAPIKey(m, CreateAPIKeyArgs{SessionToken: "member-token", Scopes: []string{scopeCredentialsWrite}}); err == nil {
			t.Fatal("overprivileged key created")
		}
		if _, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "member-token", Role: role}); err == nil {
			t.Fatal("member edited own role")
		}
		if _, err := AssignAccessRole(m, AssignRoleArgs{SessionToken: "member-token", ID: "membership", RoleID: "full"}); err == nil {
			t.Fatal("member promoted self")
		}
		if _, err := AssignAccessRole(m, AssignRoleArgs{SessionToken: "other-token", ID: "membership", RoleID: role.ID}); err == nil {
			t.Fatal("cross-workspace assignment")
		}
		if _, err := SkillsSync(q, WorkspaceSyncArgs{SessionToken: "member-token", OwnerID: "owner"}); err == nil {
			t.Fatal("member subscribed to workspace-wide sync")
		}
		if _, err := DeleteAccessRole(m, RemoveMemberArgs{SessionToken: "owner-token", ID: role.ID}); err == nil {
			t.Fatal("assigned role deleted")
		}
	})
	t.Run("invitation carries role on acceptance", func(t *testing.T) {
		if _, err := InviteTeamMember(m, InviteMemberArgs{SessionToken: "owner-token", Email: "guest@example.com"}); err == nil {
			t.Fatal("invited without explicit role")
		}
		invite, err := InviteTeamMember(m, InviteMemberArgs{SessionToken: "owner-token", Email: "guest@example.com", RoleID: role.ID})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = AcceptInvitation(m, InvitationArgs{SessionToken: "guest-token", ID: invite.ID}); err != nil {
			t.Fatal(err)
		}
		var assigned string
		if err = db.QueryRow(`select role_id from skill_workspace_members where email='guest@example.com'`).Scan(&assigned); err != nil || assigned != role.ID {
			t.Fatal("invitation lost role", err)
		}
	})
	t.Run("downgrade affects existing key and session", func(t *testing.T) {
		role.SkillIDs = []string{}
		role.CredentialIDs = []string{}
		if _, err := SaveAccessRole(m, SaveRoleArgs{SessionToken: "owner-token", Role: role}); err != nil {
			t.Fatal(err)
		}
		for _, agent := range []bool{false, true} {
			token := "member-token"
			if agent {
				token = key.APIKey
			}
			if err := requireAccess(context, db, token, agent, scopeSkillsRead, "allowed", ""); err == nil {
				t.Fatal("downgrade did not restrict access")
			}
		}
		if _, err := RemoveTeamMember(m, RemoveMemberArgs{SessionToken: "owner-token", ID: "membership"}); err != nil {
			t.Fatal(err)
		}
		if _, err := AgentListSkills(q, AgentSkillArgs{APIKey: key.APIKey}); err == nil {
			t.Fatal("removed member key still valid")
		}
	})
}
