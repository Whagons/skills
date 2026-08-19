package backend

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/gonvex/gonvex/pkg/gonvex"
)

// Durable sync collections backing the vault UI. Each collection is scoped to
// one workspace through EqualArg("... owner id", "ownerId"); the handler
// rejects a subscribe whose ownerId does not match the session's workspace, so
// deltas can only flow for a workspace the caller belongs to. Secret-bearing
// columns (the API key hash, the credential secret) are deliberately absent
// from every projection: projected columns are persisted in the browser's
// IndexedDB and in the durable change log.
func registerSyncs(app *gonvex.App) {
	app.Sync(
		"skills.sync",
		SkillsSync,
		gonvex.SyncTable("skills").
			Key("id").
			Columns("id", "owner_id", "name", "summary", "content", "created_at", "updated_at", "approved_at", "approved_by").
			EqualArg("owner_id", "ownerId").
			OrderBy("updated_at", "desc").
			Eager().
			Budget(2000, 16777216),
		gonvex.Reads("skills").Columns("id", "owner_id", "updated_at"),
	)
	app.Sync(
		"apiKeys.sync",
		APIKeysSync,
		gonvex.SyncTable("skill_api_keys").
			Key("id").
			Columns("id", "owner_id", "created_by", "name", "prefix", "scopes", "created_at", "expires_at", "revoked_at").
			EqualArg("owner_id", "ownerId").
			OrderBy("created_at", "desc").
			Eager().
			Budget(2000, 4194304),
		gonvex.Reads("skill_api_keys").Columns("id", "owner_id", "created_at"),
	)
	app.Sync(
		"credentials.sync",
		CredentialsSync,
		gonvex.SyncTable("skill_credentials").
			Key("id").
			Columns("id", "owner_id", "name", "summary", "created_at", "updated_at").
			EqualArg("owner_id", "ownerId").
			OrderBy("updated_at", "desc").
			Eager().
			Budget(2000, 4194304),
		gonvex.Reads("skill_credentials").Columns("id", "owner_id", "updated_at"),
	)
	app.Sync(
		"team.membersSync",
		TeamMembersSync,
		gonvex.SyncTable("skill_workspace_members").
			Key("id").
			Columns("id", "workspace_owner_id", "email", "invited_by", "created_at").
			EqualArg("workspace_owner_id", "ownerId").
			OrderBy("created_at", "desc").
			Eager().
			Budget(2000, 2097152),
		gonvex.Reads("skill_workspace_members").Columns("id", "workspace_owner_id", "created_at"),
	)
	app.Sync(
		"team.invitationsSync",
		TeamInvitationsSync,
		gonvex.SyncTable("skill_workspace_invitations").
			Key("id").
			Columns("id", "workspace_owner_id", "email", "invited_by", "created_at", "accepted_at", "rejected_at").
			EqualArg("workspace_owner_id", "ownerId").
			OrderBy("created_at", "desc").
			Eager().
			Budget(2000, 2097152),
		gonvex.Reads("skill_workspace_invitations").Columns("id", "workspace_owner_id", "created_at"),
	)
}

type WorkspaceSyncArgs struct {
	SessionToken string `json:"sessionToken"`
	OwnerID      string `json:"ownerId"`
}

// verifyWorkspaceSync authorizes a sync subscribe: the ownerId argument that
// scopes the collection must be the workspace the session is switched into.
func verifyWorkspaceSync(ctx *gonvex.QueryCtx, args WorkspaceSyncArgs) (sessionIdentity, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return sessionIdentity{}, err
	}
	if identity.PendingOnly {
		return sessionIdentity{}, errors.New("accept or reject the pending workspace invitation first")
	}
	if strings.TrimSpace(args.OwnerID) != identity.WorkspaceID {
		return sessionIdentity{}, errors.New("ownerId does not match the active workspace")
	}
	return identity, nil
}

func SkillsSync(ctx *gonvex.QueryCtx, args WorkspaceSyncArgs) ([]map[string]any, error) {
	identity, err := verifyWorkspaceSync(ctx, args)
	if err != nil {
		return nil, err
	}
	return syncRows(ctx.Context, ctx.DB,
		[]string{"id", "owner_id", "name", "summary", "content", "created_at", "updated_at", "approved_at", "approved_by"},
		`select id, owner_id, name, summary, content, created_at, updated_at, approved_at, approved_by
		from skills where owner_id = $1 order by updated_at desc`, identity.WorkspaceID)
}

func APIKeysSync(ctx *gonvex.QueryCtx, args WorkspaceSyncArgs) ([]map[string]any, error) {
	identity, err := verifyWorkspaceSync(ctx, args)
	if err != nil {
		return nil, err
	}
	return syncRows(ctx.Context, ctx.DB,
		[]string{"id", "owner_id", "created_by", "name", "prefix", "scopes", "created_at", "expires_at", "revoked_at"},
		`select id, owner_id, created_by, name, prefix, scopes, created_at, expires_at, revoked_at
		from skill_api_keys where owner_id = $1 order by created_at desc`, identity.WorkspaceID)
}

func CredentialsSync(ctx *gonvex.QueryCtx, args WorkspaceSyncArgs) ([]map[string]any, error) {
	identity, err := verifyWorkspaceSync(ctx, args)
	if err != nil {
		return nil, err
	}
	return syncRows(ctx.Context, ctx.DB,
		[]string{"id", "owner_id", "name", "summary", "created_at", "updated_at"},
		`select id, owner_id, name, summary, created_at, updated_at
		from skill_credentials where owner_id = $1 order by updated_at desc`, identity.WorkspaceID)
}

func TeamMembersSync(ctx *gonvex.QueryCtx, args WorkspaceSyncArgs) ([]map[string]any, error) {
	identity, err := verifyWorkspaceSync(ctx, args)
	if err != nil {
		return nil, err
	}
	return syncRows(ctx.Context, ctx.DB,
		[]string{"id", "workspace_owner_id", "email", "invited_by", "created_at"},
		`select id, workspace_owner_id, email, invited_by, created_at
		from skill_workspace_members where workspace_owner_id = $1 order by created_at desc`, identity.WorkspaceID)
}

func TeamInvitationsSync(ctx *gonvex.QueryCtx, args WorkspaceSyncArgs) ([]map[string]any, error) {
	identity, err := verifyWorkspaceSync(ctx, args)
	if err != nil {
		return nil, err
	}
	if !identity.IsWorkspaceOwner() {
		return nil, errors.New("only the workspace owner can watch invitations")
	}
	return syncRows(ctx.Context, ctx.DB,
		[]string{"id", "workspace_owner_id", "email", "invited_by", "created_at", "accepted_at", "rejected_at"},
		`select id, workspace_owner_id, email, invited_by, created_at, accepted_at, rejected_at
		from skill_workspace_invitations where workspace_owner_id = $1 order by created_at desc`, identity.WorkspaceID)
}

func syncRows(ctx context.Context, db *sql.DB, columns []string, query string, args ...any) ([]map[string]any, error) {
	if db == nil {
		return nil, errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(columns))
		for i, column := range columns {
			if b, ok := values[i].([]byte); ok {
				values[i] = string(b)
			}
			row[column] = values[i]
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
