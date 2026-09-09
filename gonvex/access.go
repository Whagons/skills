package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/gonvex/gonvex/pkg/gonvex"
)

// Resource IDs, never names, define grants. Empty selections grant nothing.
type AccessRole struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Scopes         []string `json:"scopes"`
	AllSkills      bool     `json:"all_skills"`
	SkillIDs       []string `json:"skill_ids"`
	AllCredentials bool     `json:"all_credentials"`
	CredentialIDs  []string `json:"credential_ids"`
}
type SaveRoleArgs struct {
	SessionToken string     `json:"sessionToken"`
	Role         AccessRole `json:"role"`
}
type AssignRoleArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
	RoleID       string `json:"role_id"`
}
type AccessState struct {
	Role        AccessRole        `json:"role"`
	Roles       []AccessRole      `json:"roles"`
	Assignments map[string]string `json:"assignments"`
}

func fullAccess() AccessRole {
	return AccessRole{ID: "full", Name: "Full access", Description: "All skills, credentials and API keys. Only the owner manages people and roles.", Scopes: []string{scopeSkillsRead, scopeSkillsWrite, scopeCredentialsRead, scopeCredentialsWrite, scopeKeysRead, scopeKeysRevoke}, AllSkills: true, AllCredentials: true, SkillIDs: []string{}, CredentialIDs: []string{}}
}
func containsID(ids []string, id string) bool {
	for _, value := range ids {
		if value == id {
			return true
		}
	}
	return false
}
func (r AccessRole) allows(scope, id string) bool {
	if !containsID(r.Scopes, scope) {
		return false
	}
	if strings.HasPrefix(scope, "skills:") {
		return r.AllSkills || id != "" && containsID(r.SkillIDs, id)
	}
	if strings.HasPrefix(scope, "credentials:") {
		return r.AllCredentials || id != "" && containsID(r.CredentialIDs, id)
	}
	return true
}
func readRole(ctx context.Context, db queryer, workspace, id string) (AccessRole, error) {
	if id == "" || id == "full" {
		return fullAccess(), nil
	}
	var raw string
	if err := db.QueryRowContext(ctx, `select policy from skill_access_roles where workspace_owner_id=$1 and id=$2`, workspace, id).Scan(&raw); err != nil {
		return AccessRole{}, errors.New("role is unavailable")
	}
	var role AccessRole
	if err := json.Unmarshal([]byte(raw), &role); err != nil {
		return AccessRole{}, err
	}
	return role, nil
}
func identityRole(ctx context.Context, db queryer, identity sessionIdentity) (AccessRole, error) {
	if identity.PendingOnly {
		return AccessRole{}, errors.New("accept or reject the pending workspace invitation first")
	}
	if identity.IsWorkspaceOwner() {
		return fullAccess(), nil
	}
	var id string
	err := db.QueryRowContext(ctx, `select m.role_id from skill_workspace_members m join skill_users u on lower(u.email)=lower(m.email) where m.workspace_owner_id=$1 and u.owner_id=$2`, identity.WorkspaceID, identity.OwnerID).Scan(&id)
	if err != nil {
		return AccessRole{}, err
	}
	return readRole(ctx, db, identity.WorkspaceID, id)
}
func callerRole(ctx context.Context, db *sql.DB, token string, agent bool) (string, AccessRole, error) {
	if !agent {
		identity, err := verifySessionIdentity(ctx, db, token)
		if err != nil {
			return "", AccessRole{}, err
		}
		role, err := identityRole(ctx, db, identity)
		return identity.WorkspaceID, role, err
	}
	workspace, err := verifyAPIKey(ctx, db, token, "")
	if err != nil {
		return "", AccessRole{}, err
	}
	var creator, scopes string
	if err = db.QueryRowContext(ctx, `select created_by,scopes from skill_api_keys where key_hash=$1`, hashToken(strings.TrimSpace(token))).Scan(&creator, &scopes); err != nil {
		return "", AccessRole{}, err
	}
	if creator == "" {
		creator = workspace
	}
	role, err := identityRole(ctx, db, sessionIdentity{OwnerID: creator, WorkspaceID: workspace})
	if err != nil {
		return "", AccessRole{}, err
	}
	allowed := []string{}
	for _, scope := range role.Scopes {
		if scopeAllowed(scopes, scope) {
			allowed = append(allowed, scope)
		}
	}
	role.Scopes = allowed
	return workspace, role, nil
}

// Resolve every supplied selector, preventing an allowed ID from masking a
// forbidden name in the legacy get/upsert SQL. Creation requires all-resource access.
func requireAccess(ctx context.Context, db *sql.DB, token string, agent bool, scope, id, name string) error {
	workspace, role, err := callerRole(ctx, db, token, agent)
	if err != nil {
		return err
	}
	if !containsID(role.Scopes, scope) {
		return errors.New("your role does not allow this action")
	}
	table := ""
	if strings.HasPrefix(scope, "skills:") {
		table = "skills"
	}
	if strings.HasPrefix(scope, "credentials:") {
		table = "skill_credentials"
	}
	if table == "" {
		return nil
	}
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	if id != "" && !role.allows(scope, id) {
		return errors.New("your role does not allow access to this item")
	}
	if name != "" {
		found := false
		rows, err := db.QueryContext(ctx, `select id from `+table+` where owner_id=$1 and lower(name)=lower($2)`, workspace, name)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			found = true
			var resolved string
			if err := rows.Scan(&resolved); err != nil {
				return err
			}
			if !role.allows(scope, resolved) {
				return errors.New("your role does not allow access to this item")
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if found || role.allows(scope, id) {
			return nil
		}
		return errors.New("your role does not allow creating items")
	}
	if !role.allows(scope, id) {
		return errors.New("your role does not allow access to this item")
	}
	return nil
}
func registerAccess(app *gonvex.App) {
	app.Query("access.state", AccessStateQuery, gonvex.Reads("skill_sessions", "skill_users", "skill_access_roles", "skill_workspace_members", "skill_workspace_invitations"))
	app.Query("access.vault", AccessVault, gonvex.Reads("skill_sessions", "skill_users", "skill_api_keys", "skills", "skill_credentials", "skill_access_roles", "skill_workspace_members"))
	app.Mutation("access.saveRole", SaveAccessRole, gonvex.Writes("skill_access_roles"))
	app.Mutation("access.deleteRole", DeleteAccessRole, gonvex.Writes("skill_access_roles"))
	app.Mutation("access.assignRole", AssignAccessRole, gonvex.Writes("skill_workspace_members", "skill_workspace_invitations"))
}
func AccessStateQuery(ctx *gonvex.QueryCtx, args SessionArgs) (AccessState, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return AccessState{}, err
	}
	role, err := identityRole(ctx.Context, ctx.DB, identity)
	if err != nil {
		return AccessState{}, err
	}
	state := AccessState{Role: role, Roles: []AccessRole{}, Assignments: map[string]string{}}
	if !identity.IsWorkspaceOwner() {
		return state, nil
	}
	state.Roles = append(state.Roles, fullAccess())
	rows, err := ctx.DB.QueryContext(ctx.Context, `select policy from skill_access_roles where workspace_owner_id=$1 order by name`, identity.WorkspaceID)
	if err != nil {
		return state, err
	}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return state, err
		}
		var r AccessRole
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			rows.Close()
			return state, err
		}
		state.Roles = append(state.Roles, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return state, err
	}
	rows, err = ctx.DB.QueryContext(ctx.Context, `select id,role_id from skill_workspace_members where workspace_owner_id=$1 union all select id,role_id from skill_workspace_invitations where workspace_owner_id=$1 and accepted_at is null and rejected_at is null`, identity.WorkspaceID)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, roleID string
		if err = rows.Scan(&id, &roleID); err != nil {
			return state, err
		}
		if roleID == "" {
			roleID = "full"
		}
		state.Assignments[id] = roleID
	}
	return state, rows.Err()
}
func SaveAccessRole(ctx *gonvex.MutationCtx, args SaveRoleArgs) (AccessRole, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return AccessRole{}, err
	}
	if !identity.IsWorkspaceOwner() {
		return AccessRole{}, errors.New("only the workspace owner can manage roles")
	}
	role := args.Role
	role.Name = strings.TrimSpace(role.Name)
	if role.Name == "" || len(role.Name) > 80 || len(role.Description) > 500 || role.ID == "full" || len(role.ID) > 240 {
		return AccessRole{}, errors.New("enter a role name of up to 80 characters")
	}
	role.Scopes, err = normalizeScopes(role.Scopes)
	if err != nil {
		return AccessRole{}, err
	}
	for _, kind := range []string{"skills", "credentials"} {
		if containsID(role.Scopes, kind+":write") && !containsID(role.Scopes, kind+":read") {
			return AccessRole{}, errors.New("editing requires read access")
		}
	}
	if len(role.SkillIDs) > maxWorkspaceSkills || len(role.CredentialIDs) > maxWorkspaceCredentials {
		return AccessRole{}, errors.New("too many selected resources")
	}
	runner := mutationRunner(ctx)
	for table, ids := range map[string][]string{"skills": role.SkillIDs, "skill_credentials": role.CredentialIDs} {
		for _, id := range ids {
			var exists bool
			if err = runner.QueryRowContext(ctx.Context, `select exists(select 1 from `+table+` where owner_id=$1 and id=$2)`, identity.WorkspaceID, id).Scan(&exists); err != nil {
				return AccessRole{}, err
			}
			if !exists {
				return AccessRole{}, errors.New("a selected item no longer exists in this workspace")
			}
		}
	}
	if role.ID == "" {
		role.ID, err = randomID()
		if err != nil {
			return role, err
		}
		var count int
		if err = runner.QueryRowContext(ctx.Context, `select count(*) from skill_access_roles where workspace_owner_id=$1`, identity.WorkspaceID).Scan(&count); err != nil {
			return role, err
		}
		if count >= 50 {
			return role, errors.New("workspace role limit reached")
		}
	} else {
		if _, err = readRole(ctx.Context, runner, identity.WorkspaceID, role.ID); err != nil {
			return role, err
		}
	}
	raw, err := json.Marshal(role)
	if err != nil {
		return role, err
	}
	_, err = runner.ExecContext(ctx.Context, `insert into skill_access_roles(id,workspace_owner_id,name,policy) values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,policy=excluded.policy where skill_access_roles.workspace_owner_id=excluded.workspace_owner_id`, role.ID, identity.WorkspaceID, role.Name, string(raw))
	return role, err
}
func AssignAccessRole(ctx *gonvex.MutationCtx, args AssignRoleArgs) (DeleteResult, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	if !identity.IsWorkspaceOwner() {
		return DeleteResult{}, errors.New("only the workspace owner can assign roles")
	}
	if args.RoleID == "" {
		return DeleteResult{}, errors.New("choose a role")
	}
	runner := mutationRunner(ctx)
	if _, err = readRole(ctx.Context, runner, identity.WorkspaceID, args.RoleID); err != nil {
		return DeleteResult{}, err
	}
	var count int64
	for _, table := range []string{"skill_workspace_members", "skill_workspace_invitations"} {
		result, err := runner.ExecContext(ctx.Context, `update `+table+` set role_id=$1 where workspace_owner_id=$2 and id=$3`, args.RoleID, identity.WorkspaceID, args.ID)
		if err != nil {
			return DeleteResult{}, err
		}
		n, _ := result.RowsAffected()
		count += n
	}
	if count == 0 {
		return DeleteResult{}, errors.New("member or invitation no longer exists")
	}
	return DeleteResult{Deleted: true}, nil
}
func DeleteAccessRole(ctx *gonvex.MutationCtx, args RemoveMemberArgs) (DeleteResult, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	if !identity.IsWorkspaceOwner() {
		return DeleteResult{}, errors.New("only the workspace owner can delete roles")
	}
	if args.ID == "" || args.ID == "full" {
		return DeleteResult{}, errors.New("the built-in role cannot be deleted")
	}
	runner := mutationRunner(ctx)
	var used bool
	if err = runner.QueryRowContext(ctx.Context, `select exists(select 1 from skill_workspace_members where workspace_owner_id=$1 and role_id=$2 union all select 1 from skill_workspace_invitations where workspace_owner_id=$1 and role_id=$2 and accepted_at is null and rejected_at is null)`, identity.WorkspaceID, args.ID).Scan(&used); err != nil {
		return DeleteResult{}, err
	}
	if used {
		return DeleteResult{}, errors.New("assign members and pending invitations another role first")
	}
	result, err := runner.ExecContext(ctx.Context, `delete from skill_access_roles where workspace_owner_id=$1 and id=$2`, identity.WorkspaceID, args.ID)
	if err != nil {
		return DeleteResult{}, err
	}
	n, _ := result.RowsAffected()
	return DeleteResult{Deleted: n > 0}, nil
}

// Members use reauthorized snapshots, never workspace-wide durable sync. The
// latter's delta filter cannot represent per-resource role grants safely.
func AccessVault(ctx *gonvex.QueryCtx, args SessionArgs) (map[string]any, error) {
	workspace, role, err := callerRole(ctx.Context, ctx.DB, args.SessionToken, false)
	if err != nil {
		return nil, err
	}
	skills, err := syncRows(ctx.Context, ctx.DB, []string{"id", "owner_id", "name", "summary", "content", "created_at", "updated_at", "approved_at", "approved_by"}, `select id,owner_id,name,summary,content,created_at,updated_at,approved_at,approved_by from skills where owner_id=$1`, workspace)
	if err != nil {
		return nil, err
	}
	credentials, err := syncRows(ctx.Context, ctx.DB, []string{"id", "owner_id", "name", "summary", "created_at", "updated_at"}, `select id,owner_id,name,summary,created_at,updated_at from skill_credentials where owner_id=$1`, workspace)
	if err != nil {
		return nil, err
	}
	visibleSkills := []map[string]any{}
	for _, row := range skills {
		if role.allows(scopeSkillsRead, row["id"].(string)) {
			visibleSkills = append(visibleSkills, row)
		}
	}
	visibleCredentials := []map[string]any{}
	for _, row := range credentials {
		if role.allows(scopeCredentialsRead, row["id"].(string)) {
			visibleCredentials = append(visibleCredentials, row)
		}
	}
	keys, err := visibleAPIKeys(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	return map[string]any{"skills": visibleSkills, "credentials": visibleCredentials, "keys": keys}, nil
}

func visibleAPIKeys(ctx context.Context, db *sql.DB, token string) ([]APIKeyRecord, error) {
	identity, err := verifySessionIdentity(ctx, db, token)
	if err != nil {
		return nil, err
	}
	role, err := identityRole(ctx, db, identity)
	if err != nil {
		return nil, err
	}
	keys, err := listAPIKeys(ctx, db, identity.WorkspaceID)
	if err != nil {
		return nil, err
	}
	visible := []APIKeyRecord{}
	for _, key := range keys {
		if key.CreatedBy == identity.OwnerID || role.allows(scopeKeysRead, "") {
			key.CanRevoke = key.CreatedBy == identity.OwnerID || role.allows(scopeKeysRevoke, "")
			visible = append(visible, key)
		}
	}
	return visible, nil
}
