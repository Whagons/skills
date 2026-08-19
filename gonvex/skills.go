package backend

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/gonvex/gonvex/pkg/gonvex"
)

const (
	sessionTTL              = 30 * 24 * time.Hour
	defaultAPIKeyTTL        = 30 * 24 * time.Hour
	maxAPIKeyTTL            = 365 * 24 * time.Hour
	maxSkillContentBytes    = 2 << 20
	maxCredentialValueSize  = 256 << 10
	maxNameLength           = 120
	maxSummaryLength        = 1000
	maxWorkspaceSkills      = 500
	maxWorkspaceKeys        = 50
	maxWorkspaceCredentials = 100
	maxWorkspaceMembers     = 50
	defaultGoogleClientID   = "578623964983-iall0oeq2r2mke7trpqqv3pjingqljh0.apps.googleusercontent.com"
	defaultAllowedEmail     = "malek.gabriel33@gmail.com"
)

const (
	scopeSkillsRead       = "skills:read"
	scopeSkillsWrite      = "skills:write"
	scopeCredentialsRead  = "credentials:read"
	scopeCredentialsWrite = "credentials:write"
	scopeKeysRead         = "keys:read"
	scopeKeysRevoke       = "keys:revoke"
)

type SessionArgs struct {
	SessionToken string `json:"sessionToken"`
}

type SwitchWorkspaceArgs struct {
	SessionToken string `json:"sessionToken"`
	WorkspaceID  string `json:"workspace_id"`
}

type WorkspaceRecord struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	IsOwner bool   `json:"is_owner"`
	Active  bool   `json:"active"`
}

type LoginArgs struct {
	IDToken string `json:"idToken"`
}

type LoginResult struct {
	SessionToken string    `json:"sessionToken"`
	ExpiresAt    time.Time `json:"expires_at"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	IsOwner      bool      `json:"is_owner"`
	PendingOnly  bool      `json:"pending_only"`
}

type MeResult struct {
	Email          string `json:"email"`
	Name           string `json:"name"`
	IsOwner        bool   `json:"is_owner"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceEmail string `json:"workspace_email"`
	PendingOnly    bool   `json:"pending_only"`
}

type InviteMemberArgs struct {
	SessionToken string `json:"sessionToken"`
	Email        string `json:"email"`
}

type RemoveMemberArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
}

type InvitationArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
}

type WorkspaceInvitation struct {
	ID             string    `json:"id"`
	WorkspaceID    string    `json:"workspace_id"`
	WorkspaceEmail string    `json:"workspace_email"`
	Email          string    `json:"email"`
	CreatedAt      time.Time `json:"created_at"`
}

type TeamMember struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
	Status    string    `json:"status"`
}

type SaveSkillArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
	Name         string `json:"name"`
	Summary      string `json:"summary"`
	Content      string `json:"content"`
}

type DeleteSkillArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
}

type AgentSkillArgs struct {
	APIKey string `json:"apiKey"`
	ID     string `json:"id"`
	Name   string `json:"name"`
}

type AgentSaveSkillArgs struct {
	APIKey  string `json:"apiKey"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Content string `json:"content"`
}

type AgentRevokeAPIKeyArgs struct {
	APIKey string `json:"apiKey"`
	ID     string `json:"id"`
}

type CreateAPIKeyArgs struct {
	SessionToken  string   `json:"sessionToken"`
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	ExpiresInDays int      `json:"expires_in_days"`
	NeverExpires  bool     `json:"never_expires"`
}

type RevokeAPIKeyArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
}

type SaveCredentialArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
	Name         string `json:"name"`
	Summary      string `json:"summary"`
	Value        string `json:"value"`
}

type GetCredentialArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
	Name         string `json:"name"`
}

type AgentSaveCredentialArgs struct {
	APIKey  string `json:"apiKey"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Value   string `json:"value"`
}

type DeleteCredentialArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
}

type AgentDeleteCredentialArgs struct {
	APIKey string `json:"apiKey"`
	ID     string `json:"id"`
}

type SkillMeta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Summary   string    `json:"summary"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Approved  bool      `json:"approved"`
}

type Skill struct {
	SkillMeta
	Content string `json:"content"`
}

type CredentialMeta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Summary   string    `json:"summary"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Credential struct {
	CredentialMeta
	Value string `json:"value"`
}

type DeleteResult struct {
	Deleted bool `json:"deleted"`
}

type APIKeyRecord struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Prefix    string     `json:"prefix"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
	ExpiresAt *time.Time `json:"expires_at"`
	Scopes    []string   `json:"scopes"`
	CreatedBy string     `json:"created_by,omitempty"`
}

type CreateAPIKeyResult struct {
	Record APIKeyRecord `json:"record"`
	APIKey string       `json:"apiKey"`
}

type googleTokenInfo struct {
	Audience      string `json:"aud"`
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified string `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
	HostedDomain  string `json:"hd"`
}

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type execQueryer interface {
	execer
	queryer
}

// Register declares every function with its real table dependencies. Without
// the Reads/Writes declarations the runtime falls back to using the path's
// first segment as the table name, so "agent.skills.upload" invalidated a
// fictional "agent" table and cached "skills.*" query results stayed stale
// until process restart — approvals and uploads made through one surface were
// invisible to the other.
func Register(app *gonvex.App) {
	app.Mutation("auth.login", Login, gonvex.Writes("skill_users", "skill_sessions"))
	app.Mutation("auth.logout", Logout, gonvex.Writes("skill_sessions"))
	app.Query("auth.me", Me, gonvex.Reads("skill_sessions", "skill_users"))
	app.Query("auth.workspaces", ListWorkspaces, gonvex.Reads("skill_sessions", "skill_users", "skill_workspace_members"))
	app.Mutation("auth.switchWorkspace", SwitchWorkspace, gonvex.Writes("skill_sessions"))
	app.Query("team.list", ListTeamMembers, gonvex.Reads("skill_workspace_members", "skill_workspace_invitations"))
	app.Mutation("team.invite", InviteTeamMember, gonvex.Writes("skill_workspace_invitations", "skill_workspace_members"))
	app.Mutation("team.remove", RemoveTeamMember, gonvex.Writes("skill_workspace_members", "skill_workspace_invitations"))
	app.Query("team.invitations.list", ListInvitations, gonvex.Reads("skill_workspace_invitations", "skill_users"))
	app.Mutation("team.invitations.accept", AcceptInvitation, gonvex.Writes("skill_workspace_members", "skill_workspace_invitations", "skill_sessions"))
	app.Mutation("team.invitations.reject", RejectInvitation, gonvex.Writes("skill_workspace_invitations", "skill_sessions"))
	app.Query("skills.list", ListSkills, gonvex.Reads("skills"))
	app.Query("skills.get", GetSkill, gonvex.Reads("skills"))
	app.Mutation("skills.save", SaveSkill, gonvex.Writes("skills"))
	app.Mutation("skills.approve", ApproveSkill, gonvex.Writes("skills"))
	app.Mutation("skills.delete", DeleteSkill, gonvex.Writes("skills"))
	app.Query("apiKeys.list", ListAPIKeys, gonvex.Reads("skill_api_keys"))
	app.Mutation("apiKeys.create", CreateAPIKey, gonvex.Writes("skill_api_keys"))
	app.Mutation("apiKeys.revoke", RevokeAPIKey, gonvex.Writes("skill_api_keys"))
	app.Query("credentials.list", ListCredentials, gonvex.Reads("skill_credentials"))
	app.Mutation("credentials.get", GetCredential, gonvex.Reads("skill_credentials"), gonvex.Writes("skill_credentials"))
	app.Mutation("credentials.save", SaveCredential, gonvex.Writes("skill_credentials"))
	app.Mutation("credentials.delete", DeleteCredential, gonvex.Writes("skill_credentials"))
	app.Query("agent.skills.list", AgentListSkills, gonvex.Reads("skills", "skill_api_keys"))
	app.Query("agent.skills.get", AgentGetSkill, gonvex.Reads("skills", "skill_api_keys"))
	app.Mutation("agent.skills.upload", AgentUploadSkill, gonvex.Writes("skills"))
	app.Mutation("agent.skills.delete", AgentDeleteSkill, gonvex.Writes("skills"))
	app.Query("agent.apiKeys.list", AgentListAPIKeys, gonvex.Reads("skill_api_keys"))
	app.Query("agent.apiKeys.verify", AgentVerifyAPIKey, gonvex.Reads("skill_api_keys"))
	// Deliberately no agent.apiKeys.create: a leaked API key must not be able
	// to mint replacement keys that survive its own revocation. New keys come
	// from a Google-verified session (UI or CLI browser flow) only.
	app.Mutation("agent.apiKeys.revoke", AgentRevokeAPIKey, gonvex.Writes("skill_api_keys"))
	app.Mutation("agent.apiKeys.revokeSelf", AgentRevokeSelf, gonvex.Writes("skill_api_keys"))
	app.Query("agent.credentials.list", AgentListCredentials, gonvex.Reads("skill_credentials", "skill_api_keys"))
	app.Query("agent.credentials.get", AgentGetCredential, gonvex.Reads("skill_credentials", "skill_api_keys"))
	app.Mutation("agent.credentials.save", AgentSaveCredential, gonvex.Writes("skill_credentials"))
	app.Mutation("agent.credentials.delete", AgentDeleteCredential, gonvex.Writes("skill_credentials"))
	registerSyncs(app)
}

func Login(ctx *gonvex.MutationCtx, args LoginArgs) (LoginResult, error) {
	if ctx.DB == nil {
		return LoginResult{}, errors.New("database is not configured")
	}
	runner := execQueryer(ctx.DB)
	if ctx.Tx != nil {
		runner = ctx.Tx
	}
	if err := ensureTables(ctx.Context, runner); err != nil {
		return LoginResult{}, err
	}
	if len(args.IDToken) > 16<<10 {
		return LoginResult{}, errors.New("google id token is too large")
	}

	info, err := verifyGoogleIDToken(ctx.Context, args.IDToken)
	if err != nil {
		return LoginResult{}, err
	}
	email := strings.ToLower(strings.TrimSpace(info.Email))
	name := strings.TrimSpace(info.Name)
	if name == "" {
		name = email
	}
	ownerID := "google:" + strings.TrimSpace(info.Subject)
	workspaceID, pendingOnly, err := resolveWorkspace(ctx.Context, runner, ownerID, email, info)
	if err != nil {
		return LoginResult{}, err
	}
	if err := upsertUser(ctx.Context, runner, ownerID, email, name, identityAllowed(info)); err != nil {
		return LoginResult{}, err
	}
	if err := claimLegacyRows(ctx.Context, runner, ownerID, email); err != nil {
		return LoginResult{}, err
	}

	token, err := randomToken("skv_sess_")
	if err != nil {
		return LoginResult{}, err
	}
	// Login is a natural, low-frequency place to prune session rows that
	// expired long ago so the table does not grow forever.
	if _, err := runner.ExecContext(ctx.Context, `delete from skill_sessions where expires_at < now() - interval '7 days'`); err != nil {
		return LoginResult{}, err
	}
	now := time.Now().UTC()
	expires := now.Add(sessionTTL)
	_, err = runner.ExecContext(ctx.Context, `
		insert into skill_sessions (id, owner_id, workspace_id, token_hash, pending_only, created_at, expires_at)
		values ($1, $2, $3, $4, $5, $6, $7)
	`, mustRandomID(), ownerID, workspaceID, hashToken(token), pendingOnly, now, expires)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{SessionToken: token, ExpiresAt: expires, Email: email, Name: name, IsOwner: ownerID == workspaceID && !pendingOnly, PendingOnly: pendingOnly}, nil
}

// resolveWorkspace never silently moves an allowlisted owner into somebody
// else's workspace. Non-owners receive a pending-only session until they
// explicitly accept an invitation.
func resolveWorkspace(ctx context.Context, runner queryer, ownerID string, email string, info googleTokenInfo) (string, bool, error) {
	if identityAllowed(info) {
		return ownerID, false, nil
	}
	var workspaceID string
	err := runner.QueryRowContext(ctx, `
		select workspace_owner_id
		from skill_workspace_members
		where email = $1
		order by created_at desc
		limit 1
	`, email).Scan(&workspaceID)
	if err == nil && strings.TrimSpace(workspaceID) != "" && workspaceID != ownerID {
		return workspaceID, false, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	err = runner.QueryRowContext(ctx, `
		select workspace_owner_id
		from skill_workspace_invitations
		where lower(email) = $1 and accepted_at is null and rejected_at is null
		order by created_at desc
		limit 1
	`, email).Scan(&workspaceID)
	if err == nil && strings.TrimSpace(workspaceID) != "" {
		return workspaceID, true, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	return "", false, errors.New("google account is not allowed for this vault")
}

func Logout(ctx *gonvex.MutationCtx, args SessionArgs) (DeleteResult, error) {
	if ctx.DB == nil {
		return DeleteResult{}, errors.New("database is not configured")
	}
	runner := execer(ctx.DB)
	if ctx.Tx != nil {
		runner = ctx.Tx
	}
	if err := ensureTables(ctx.Context, runner); err != nil {
		return DeleteResult{}, err
	}
	result, err := runner.ExecContext(ctx.Context, `update skill_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, hashToken(args.SessionToken))
	if err != nil {
		return DeleteResult{}, err
	}
	count, _ := result.RowsAffected()
	return DeleteResult{Deleted: count > 0}, nil
}

func Me(ctx *gonvex.QueryCtx, args SessionArgs) (MeResult, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return MeResult{}, err
	}
	result := MeResult{IsOwner: identity.IsWorkspaceOwner(), WorkspaceID: identity.WorkspaceID, PendingOnly: identity.PendingOnly}
	result.Email, result.Name, _ = lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if !result.IsOwner {
		result.WorkspaceEmail, _, _ = lookupUser(ctx.Context, ctx.DB, identity.WorkspaceID)
	}
	return result, nil
}

func ListWorkspaces(ctx *gonvex.QueryCtx, args SessionArgs) ([]WorkspaceRecord, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	email, _, err := lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if err != nil {
		return nil, err
	}
	rows, err := ctx.DB.QueryContext(ctx.Context, `
		select workspace_id, workspace_email, is_owner from (
			select u.owner_id as workspace_id, u.email as workspace_email, true as is_owner
			from skill_users u where u.owner_id = $1 and u.can_own
			union
			select m.workspace_owner_id, coalesce(owner.email, ''), false
			from skill_workspace_members m
			left join skill_users owner on owner.owner_id = m.workspace_owner_id
			where lower(m.email) = lower($2)
		) workspaces
		order by is_owner desc, lower(workspace_email)
	`, identity.OwnerID, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []WorkspaceRecord{}
	for rows.Next() {
		var workspace WorkspaceRecord
		if err := rows.Scan(&workspace.ID, &workspace.Email, &workspace.IsOwner); err != nil {
			return nil, err
		}
		workspace.Active = workspace.ID == identity.WorkspaceID
		result = append(result, workspace)
	}
	return result, rows.Err()
}

func SwitchWorkspace(ctx *gonvex.MutationCtx, args SwitchWorkspaceArgs) (WorkspaceRecord, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return WorkspaceRecord{}, err
	}
	target := strings.TrimSpace(args.WorkspaceID)
	if target == "" || len(target) > 240 {
		return WorkspaceRecord{}, errors.New("valid workspace id is required")
	}
	email, _, err := lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if err != nil {
		return WorkspaceRecord{}, err
	}
	var workspace WorkspaceRecord
	err = mutationRunner(ctx).QueryRowContext(ctx.Context, `
		select workspace_id, workspace_email, is_owner from (
			select u.owner_id as workspace_id, u.email as workspace_email, true as is_owner
			from skill_users u where u.owner_id = $1 and u.can_own
			union
			select m.workspace_owner_id, coalesce(owner.email, ''), false
			from skill_workspace_members m
			left join skill_users owner on owner.owner_id = m.workspace_owner_id
			where lower(m.email) = lower($2)
		) workspaces where workspace_id = $3 limit 1
	`, identity.OwnerID, email, target).Scan(&workspace.ID, &workspace.Email, &workspace.IsOwner)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return WorkspaceRecord{}, errors.New("workspace access is not active")
		}
		return WorkspaceRecord{}, err
	}
	if _, err := mutationRunner(ctx).ExecContext(ctx.Context, `
		update skill_sessions set workspace_id = $1, pending_only = false
		where token_hash = $2 and owner_id = $3 and revoked_at is null
	`, target, hashToken(args.SessionToken), identity.OwnerID); err != nil {
		return WorkspaceRecord{}, err
	}
	workspace.Active = true
	return workspace, nil
}

func lookupUser(ctx context.Context, db queryer, ownerID string) (string, string, error) {
	var email, name string
	err := db.QueryRowContext(ctx, `select email, name from skill_users where owner_id = $1`, ownerID).Scan(&email, &name)
	return email, name, err
}

func ListTeamMembers(ctx *gonvex.QueryCtx, args SessionArgs) ([]TeamMember, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	if identity.PendingOnly {
		return nil, errors.New("accept or reject the pending workspace invitation first")
	}
	rows, err := ctx.DB.QueryContext(ctx.Context, `
		select id, email, created_at, status from (
			select id, email, created_at, 'active'::text as status
			from skill_workspace_members
			where workspace_owner_id = $1
			union all
			select id, email, created_at, 'pending'::text as status
			from skill_workspace_invitations
			where workspace_owner_id = $1
				and accepted_at is null and rejected_at is null
				and $2
		) workspace_people
		order by created_at desc
	`, identity.WorkspaceID, identity.IsWorkspaceOwner())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []TeamMember{}
	for rows.Next() {
		var member TeamMember
		if err := rows.Scan(&member.ID, &member.Email, &member.CreatedAt, &member.Status); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func InviteTeamMember(ctx *gonvex.MutationCtx, args InviteMemberArgs) (TeamMember, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return TeamMember{}, err
	}
	if !identity.IsWorkspaceOwner() {
		return TeamMember{}, errors.New("only the workspace owner can invite members")
	}
	email := strings.ToLower(strings.TrimSpace(args.Email))
	if len(email) > 320 || !strings.Contains(email, "@") || strings.IndexFunc(email, unicode.IsSpace) >= 0 || strings.IndexFunc(email, unicode.IsControl) >= 0 || strings.Contains(email, ",") {
		return TeamMember{}, errors.New("a valid google email is required")
	}
	runner := mutationRunner(ctx)
	if err := ensureTables(ctx.Context, runner); err != nil {
		return TeamMember{}, err
	}
	id, err := randomID()
	if err != nil {
		return TeamMember{}, err
	}
	ownerEmail, _, err := lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if err != nil {
		return TeamMember{}, err
	}
	if strings.EqualFold(ownerEmail, email) {
		return TeamMember{}, errors.New("the workspace owner cannot invite their own account")
	}
	var memberCount int
	if err := runner.QueryRowContext(ctx.Context, `
		select
			(select count(*) from skill_workspace_members where workspace_owner_id = $1) +
			(select count(*) from skill_workspace_invitations where workspace_owner_id = $1 and accepted_at is null and rejected_at is null)
	`, identity.WorkspaceID).Scan(&memberCount); err != nil {
		return TeamMember{}, err
	}
	if memberCount >= maxWorkspaceMembers {
		return TeamMember{}, fmt.Errorf("workspace member limit reached (%d)", maxWorkspaceMembers)
	}
	now := time.Now().UTC()
	_, err = runner.ExecContext(ctx.Context, `
		insert into skill_workspace_invitations (id, workspace_owner_id, email, invited_by, created_at)
		values ($1, $2, $3, $4, $5)
		on conflict (workspace_owner_id, email) where accepted_at is null and rejected_at is null
		do update set invited_by = excluded.invited_by, created_at = excluded.created_at
	`, id, identity.WorkspaceID, email, identity.OwnerID, now)
	if err != nil {
		return TeamMember{}, err
	}
	return TeamMember{ID: id, Email: email, CreatedAt: now, Status: "pending"}, nil
}

func ListInvitations(ctx *gonvex.QueryCtx, args SessionArgs) ([]WorkspaceInvitation, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	email, _, err := lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if err != nil {
		return nil, err
	}
	rows, err := ctx.DB.QueryContext(ctx.Context, `
		select i.id, i.workspace_owner_id, coalesce(u.email, ''), i.email, i.created_at
		from skill_workspace_invitations i
		left join skill_users u on u.owner_id = i.workspace_owner_id
		where lower(i.email) = lower($1) and i.accepted_at is null and i.rejected_at is null
		order by i.created_at desc
	`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []WorkspaceInvitation{}
	for rows.Next() {
		var invitation WorkspaceInvitation
		if err := rows.Scan(&invitation.ID, &invitation.WorkspaceID, &invitation.WorkspaceEmail, &invitation.Email, &invitation.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, invitation)
	}
	return result, rows.Err()
}

func AcceptInvitation(ctx *gonvex.MutationCtx, args InvitationArgs) (TeamMember, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return TeamMember{}, err
	}
	email, _, err := lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if err != nil {
		return TeamMember{}, err
	}
	runner := mutationRunner(ctx)
	var invitation WorkspaceInvitation
	err = runner.QueryRowContext(ctx.Context, `
		select id, workspace_owner_id, email, created_at
		from skill_workspace_invitations
		where id = $1 and lower(email) = lower($2) and accepted_at is null and rejected_at is null
		limit 1
	`, strings.TrimSpace(args.ID), email).Scan(&invitation.ID, &invitation.WorkspaceID, &invitation.Email, &invitation.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return TeamMember{}, errors.New("pending invitation not found")
		}
		return TeamMember{}, err
	}
	memberID, err := randomID()
	if err != nil {
		return TeamMember{}, err
	}
	var existingWorkspace string
	err = runner.QueryRowContext(ctx.Context, `
		select workspace_owner_id from skill_workspace_members
		where lower(email) = lower($1) and workspace_owner_id <> $2
		limit 1
	`, email, invitation.WorkspaceID).Scan(&existingWorkspace)
	if err == nil {
		return TeamMember{}, errors.New("this account already belongs to another shared workspace; leave it before accepting a different invitation")
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return TeamMember{}, err
	}
	if _, err := runner.ExecContext(ctx.Context, `
		insert into skill_workspace_members (id, workspace_owner_id, email, invited_by, created_at)
		select $1, workspace_owner_id, email, invited_by, now()
		from skill_workspace_invitations where id = $2
		on conflict (workspace_owner_id, email) do nothing
	`, memberID, invitation.ID); err != nil {
		return TeamMember{}, err
	}
	if _, err := runner.ExecContext(ctx.Context, `update skill_workspace_invitations set accepted_at = now() where id = $1`, invitation.ID); err != nil {
		return TeamMember{}, err
	}
	if _, err := runner.ExecContext(ctx.Context, `
		update skill_sessions set workspace_id = $1, pending_only = false
		where token_hash = $2 and owner_id = $3 and revoked_at is null
	`, invitation.WorkspaceID, hashToken(args.SessionToken), identity.OwnerID); err != nil {
		return TeamMember{}, err
	}
	return TeamMember{ID: memberID, Email: invitation.Email, CreatedAt: time.Now().UTC(), Status: "active"}, nil
}

func RejectInvitation(ctx *gonvex.MutationCtx, args InvitationArgs) (DeleteResult, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	email, _, err := lookupUser(ctx.Context, ctx.DB, identity.OwnerID)
	if err != nil {
		return DeleteResult{}, err
	}
	result, err := mutationRunner(ctx).ExecContext(ctx.Context, `
		update skill_workspace_invitations set rejected_at = now()
		where id = $1 and lower(email) = lower($2) and accepted_at is null and rejected_at is null
	`, strings.TrimSpace(args.ID), email)
	if err != nil {
		return DeleteResult{}, err
	}
	count, _ := result.RowsAffected()
	if identity.PendingOnly {
		_, _ = mutationRunner(ctx).ExecContext(ctx.Context, `update skill_sessions set revoked_at = now() where token_hash = $1`, hashToken(args.SessionToken))
	}
	return DeleteResult{Deleted: count > 0}, nil
}

func RemoveTeamMember(ctx *gonvex.MutationCtx, args RemoveMemberArgs) (DeleteResult, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	if !identity.IsWorkspaceOwner() {
		return DeleteResult{}, errors.New("only the workspace owner can remove members")
	}
	id := strings.TrimSpace(args.ID)
	if id == "" {
		return DeleteResult{}, errors.New("member id is required")
	}
	runner := mutationRunner(ctx)
	var email, status string
	err = runner.QueryRowContext(ctx.Context, `
		select email, status from (
			select email, 'active'::text as status
			from skill_workspace_members where workspace_owner_id = $1 and id = $2
			union all
			select email, 'pending'::text as status
			from skill_workspace_invitations
			where workspace_owner_id = $1 and id = $2
				and accepted_at is null and rejected_at is null
		) workspace_people
		limit 1
	`, identity.WorkspaceID, id).Scan(&email, &status)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DeleteResult{Deleted: false}, nil
		}
		return DeleteResult{}, err
	}
	if status == "pending" {
		if _, err := runner.ExecContext(ctx.Context, `
			delete from skill_workspace_invitations
			where workspace_owner_id = $1 and id = $2
				and accepted_at is null and rejected_at is null
		`, identity.WorkspaceID, id); err != nil {
			return DeleteResult{}, err
		}
		// Someone may already have signed in and be reviewing this invitation.
		// Revoke that pending-only session when the owner cancels access.
		if _, err := runner.ExecContext(ctx.Context, `
			update skill_sessions set revoked_at = now()
			where revoked_at is null and pending_only
				and workspace_id = $1
				and owner_id in (select owner_id from skill_users where lower(email) = lower($2))
		`, identity.WorkspaceID, email); err != nil {
			return DeleteResult{}, err
		}
		return DeleteResult{Deleted: true}, nil
	}
	if _, err := runner.ExecContext(ctx.Context, `
		delete from skill_workspace_members where workspace_owner_id = $1 and id = $2
	`, identity.WorkspaceID, id); err != nil {
		return DeleteResult{}, err
	}
	// Revoke the removed member's live sessions in this workspace so removal
	// takes effect immediately, not at session expiry.
	_, err = runner.ExecContext(ctx.Context, `
		update skill_sessions set revoked_at = now()
		where revoked_at is null
			and workspace_id = $1
			and owner_id in (select owner_id from skill_users where lower(email) = $2)
			and owner_id <> $1
	`, identity.WorkspaceID, email)
	if err != nil {
		return DeleteResult{}, err
	}
	// API keys are workspace-scoped capabilities. Revoke every key minted by
	// the removed identity, otherwise it would outlive membership removal.
	_, err = runner.ExecContext(ctx.Context, `
		update skill_api_keys set revoked_at = now()
		where owner_id = $1 and revoked_at is null
			and created_by in (select owner_id from skill_users where lower(email) = $2)
	`, identity.WorkspaceID, email)
	if err != nil {
		return DeleteResult{}, err
	}
	return DeleteResult{Deleted: true}, nil
}

func ListSkills(ctx *gonvex.QueryCtx, args SessionArgs) ([]SkillMeta, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	return listSkills(ctx.Context, ctx.DB, ownerID, false)
}

type GetSkillArgs struct {
	SessionToken string `json:"sessionToken"`
	ID           string `json:"id"`
	Name         string `json:"name"`
}

func GetSkill(ctx *gonvex.QueryCtx, args GetSkillArgs) (Skill, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return Skill{}, err
	}
	return getSkill(ctx.Context, ctx.DB, ownerID, args.ID, args.Name, false)
}

func SaveSkill(ctx *gonvex.MutationCtx, args SaveSkillArgs) (Skill, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return Skill{}, err
	}
	if identity.PendingOnly {
		return Skill{}, errors.New("accept or reject the pending workspace invitation first")
	}
	runner := mutationRunner(ctx)
	return saveSkill(ctx.Context, runner, identity.WorkspaceID, args.ID, args.Name, args.Summary, args.Content, true, identity.OwnerID)
}

func ApproveSkill(ctx *gonvex.MutationCtx, args DeleteSkillArgs) (Skill, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return Skill{}, err
	}
	if !identity.IsWorkspaceOwner() {
		return Skill{}, errors.New("only the workspace owner can approve agent-uploaded skills")
	}
	id := strings.TrimSpace(args.ID)
	if id == "" {
		return Skill{}, errors.New("skill id is required")
	}
	if len(id) > 240 {
		return Skill{}, errors.New("skill id is too long")
	}
	runner := mutationRunner(ctx)
	// updated_at must move so revision-keyed clients (UI detail cache, CLI
	// sync) refetch the approved row instead of holding the pending one.
	result, err := runner.ExecContext(ctx.Context, `
		update skills set approved_at = now(), approved_by = $1, updated_at = now()
		where owner_id = $2 and id = $3
	`, identity.OwnerID, identity.WorkspaceID, id)
	if err != nil {
		return Skill{}, err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return Skill{}, errors.New("skill not found")
	}
	// Read back through the mutation transaction; ctx.DB is a different
	// connection and cannot see the uncommitted approval, so it returns the
	// row still marked pending and the UI keeps showing the Approve button.
	return getSkill(ctx.Context, runner, identity.WorkspaceID, id, "", false)
}

func DeleteSkill(ctx *gonvex.MutationCtx, args DeleteSkillArgs) (DeleteResult, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	return deleteSkill(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func ListAPIKeys(ctx *gonvex.QueryCtx, args SessionArgs) ([]APIKeyRecord, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	return listAPIKeys(ctx.Context, ctx.DB, ownerID)
}

func listAPIKeys(ctx context.Context, db *sql.DB, ownerID string) ([]APIKeyRecord, error) {
	if db == nil {
		return []APIKeyRecord{}, nil
	}
	if err := ensureTables(ctx, db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
		select id, name, prefix, created_at, revoked_at, expires_at, scopes, created_by
		from skill_api_keys
		where owner_id = $1
		order by created_at desc
	`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := []APIKeyRecord{}
	for rows.Next() {
		var record APIKeyRecord
		var scopes string
		if err := rows.Scan(&record.ID, &record.Name, &record.Prefix, &record.CreatedAt, &record.RevokedAt, &record.ExpiresAt, &scopes, &record.CreatedBy); err != nil {
			return nil, err
		}
		record.Scopes = splitCSV(scopes)
		records = append(records, record)
	}
	return records, rows.Err()
}

func CreateAPIKey(ctx *gonvex.MutationCtx, args CreateAPIKeyArgs) (CreateAPIKeyResult, error) {
	identity, err := verifySessionIdentity(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	if identity.PendingOnly {
		return CreateAPIKeyResult{}, errors.New("accept or reject the pending workspace invitation first")
	}
	return createAPIKey(ctx.Context, mutationRunner(ctx), identity.WorkspaceID, identity.OwnerID, args.Name, args.Scopes, args.ExpiresInDays, args.NeverExpires)
}

func createAPIKey(ctx context.Context, runner execQueryer, ownerID string, createdBy string, keyName string, requestedScopes []string, expiresInDays int, neverExpires bool) (CreateAPIKeyResult, error) {
	name := strings.TrimSpace(keyName)
	if name == "" {
		name = "Agent key"
	}
	if err := ensureTables(ctx, runner); err != nil {
		return CreateAPIKeyResult{}, err
	}
	if len(name) > maxNameLength {
		return CreateAPIKeyResult{}, fmt.Errorf("api key name must be at most %d characters", maxNameLength)
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return CreateAPIKeyResult{}, errors.New("api key name contains control characters")
	}
	var activeKeys int
	if err := runner.QueryRowContext(ctx, `select count(*) from skill_api_keys where owner_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())`, ownerID).Scan(&activeKeys); err != nil {
		return CreateAPIKeyResult{}, err
	}
	if activeKeys >= maxWorkspaceKeys {
		return CreateAPIKeyResult{}, fmt.Errorf("active api key limit reached (%d)", maxWorkspaceKeys)
	}
	scopes, err := normalizeScopes(requestedScopes)
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	if len(scopes) == 0 {
		scopes = []string{scopeSkillsRead}
	}
	var expiresAt *time.Time
	if !neverExpires {
		maxDays := int(maxAPIKeyTTL / (24 * time.Hour))
		if expiresInDays < 0 || expiresInDays > maxDays {
			return CreateAPIKeyResult{}, fmt.Errorf("api keys may expire at most %d days from creation", maxDays)
		}
		ttl := defaultAPIKeyTTL
		if expiresInDays > 0 {
			ttl = time.Duration(expiresInDays) * 24 * time.Hour
		}
		value := time.Now().UTC().Add(ttl)
		expiresAt = &value
	}
	id, err := randomID()
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	apiKey, err := randomToken("skv_")
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	prefix := apiKey
	if len(prefix) > 14 {
		prefix = prefix[:14]
	}
	now := time.Now().UTC()
	_, err = runner.ExecContext(ctx, `
		insert into skill_api_keys (id, owner_id, created_by, name, key_hash, prefix, scopes, created_at, expires_at)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, id, ownerID, createdBy, name, hashToken(apiKey), prefix, strings.Join(scopes, ","), now, expiresAt)
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	return CreateAPIKeyResult{
		Record: APIKeyRecord{ID: id, Name: name, Prefix: prefix, CreatedAt: now, ExpiresAt: expiresAt, Scopes: scopes, CreatedBy: createdBy},
		APIKey: apiKey,
	}, nil
}

func RevokeAPIKey(ctx *gonvex.MutationCtx, args RevokeAPIKeyArgs) (DeleteResult, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	return revokeAPIKey(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func revokeAPIKey(ctx context.Context, runner execer, ownerID string, apiKeyID string) (DeleteResult, error) {
	id := strings.TrimSpace(apiKeyID)
	if id == "" {
		return DeleteResult{}, errors.New("api key id is required")
	}
	if len(id) > 240 {
		return DeleteResult{}, errors.New("api key id is too long")
	}
	if err := ensureTables(ctx, runner); err != nil {
		return DeleteResult{}, err
	}
	result, err := runner.ExecContext(ctx, `update skill_api_keys set revoked_at = now() where owner_id = $1 and id = $2 and revoked_at is null`, ownerID, id)
	if err != nil {
		return DeleteResult{}, err
	}
	count, _ := result.RowsAffected()
	return DeleteResult{Deleted: count > 0}, nil
}

func ListCredentials(ctx *gonvex.QueryCtx, args SessionArgs) ([]CredentialMeta, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	return listCredentialMeta(ctx.Context, ctx.DB, ownerID)
}

func GetCredential(ctx *gonvex.MutationCtx, args GetCredentialArgs) (Credential, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return Credential{}, err
	}
	keys := credentialKeyConfig{
		Current:  ctx.EnvValue("SKILLS_SECRET_KEY"),
		Previous: ctx.EnvValue("SKILLS_SECRET_KEY_PREVIOUS"),
	}
	return getCredential(ctx.Context, ctx.DB, ownerID, args.ID, args.Name, keys)
}

func SaveCredential(ctx *gonvex.MutationCtx, args SaveCredentialArgs) (CredentialMeta, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return CredentialMeta{}, err
	}
	keys := credentialKeyConfig{
		Current:  ctx.EnvValue("SKILLS_SECRET_KEY"),
		Previous: ctx.EnvValue("SKILLS_SECRET_KEY_PREVIOUS"),
	}
	return saveCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID, args.Name, args.Summary, args.Value, keys)
}

func saveCredential(ctx context.Context, runner execQueryer, ownerID string, credentialID string, credentialName string, credentialSummary string, credentialValue string, keys credentialKeyConfig) (CredentialMeta, error) {
	name := strings.TrimSpace(credentialName)
	value := credentialValue
	if name == "" {
		return CredentialMeta{}, errors.New("credential name is required")
	}
	if value == "" {
		return CredentialMeta{}, errors.New("credential value is required")
	}
	if len(name) > maxNameLength || len(credentialSummary) > maxSummaryLength {
		return CredentialMeta{}, errors.New("credential name or summary exceeds the allowed length")
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 || strings.IndexFunc(credentialSummary, unicode.IsControl) >= 0 {
		return CredentialMeta{}, errors.New("credential name or summary contains control characters")
	}
	if len(value) > maxCredentialValueSize {
		return CredentialMeta{}, fmt.Errorf("credential value exceeds the %d-byte limit", maxCredentialValueSize)
	}
	if err := ensureTables(ctx, runner); err != nil {
		return CredentialMeta{}, err
	}
	id := strings.TrimSpace(credentialID)
	if id == "" {
		nextID, err := randomID()
		if err != nil {
			return CredentialMeta{}, err
		}
		id = nextID
	}
	if len(id) > 240 {
		return CredentialMeta{}, errors.New("credential id is too long")
	}
	id = existingCredentialID(ctx, runner, ownerID, id, name)
	var exists bool
	if err := runner.QueryRowContext(ctx, `select exists(select 1 from skill_credentials where owner_id = $1 and id = $2)`, ownerID, id).Scan(&exists); err != nil {
		return CredentialMeta{}, err
	}
	if !exists {
		var count int
		if err := runner.QueryRowContext(ctx, `select count(*) from skill_credentials where owner_id = $1`, ownerID).Scan(&count); err != nil {
			return CredentialMeta{}, err
		}
		if count >= maxWorkspaceCredentials {
			return CredentialMeta{}, fmt.Errorf("workspace credential limit reached (%d)", maxWorkspaceCredentials)
		}
	}
	storedValue, err := encryptSecret(keys, ownerID, id, value)
	if err != nil {
		return CredentialMeta{}, err
	}
	now := time.Now().UTC()
	var createdAt time.Time
	err = runner.QueryRowContext(ctx, `
		insert into skill_credentials (id, owner_id, name, summary, secret_value, created_at, updated_at)
		values ($1, $2, $3, $4, $5, $6, $6)
		on conflict (id) do update set
			name = excluded.name,
			summary = excluded.summary,
			secret_value = excluded.secret_value,
			updated_at = excluded.updated_at
		returning created_at
	`, id, ownerID, name, strings.TrimSpace(credentialSummary), storedValue, now).Scan(&createdAt)
	if err != nil {
		return CredentialMeta{}, err
	}
	return CredentialMeta{ID: id, Name: name, Summary: strings.TrimSpace(credentialSummary), CreatedAt: createdAt, UpdatedAt: now}, nil
}

func DeleteCredential(ctx *gonvex.MutationCtx, args DeleteCredentialArgs) (DeleteResult, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return DeleteResult{}, err
	}
	return deleteCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func deleteCredential(ctx context.Context, runner execer, ownerID string, credentialID string) (DeleteResult, error) {
	id := strings.TrimSpace(credentialID)
	if id == "" {
		return DeleteResult{}, errors.New("credential id is required")
	}
	if err := ensureTables(ctx, runner); err != nil {
		return DeleteResult{}, err
	}
	result, err := runner.ExecContext(ctx, `delete from skill_credentials where owner_id = $1 and id = $2`, ownerID, id)
	if err != nil {
		return DeleteResult{}, err
	}
	count, _ := result.RowsAffected()
	return DeleteResult{Deleted: count > 0}, nil
}

func AgentListSkills(ctx *gonvex.QueryCtx, args AgentSkillArgs) ([]SkillMeta, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeSkillsRead)
	if err != nil {
		return nil, err
	}
	return listSkills(ctx.Context, ctx.DB, ownerID, true)
}

func AgentGetSkill(ctx *gonvex.QueryCtx, args AgentSkillArgs) (Skill, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeSkillsRead)
	if err != nil {
		return Skill{}, err
	}
	return getSkill(ctx.Context, ctx.DB, ownerID, args.ID, args.Name, true)
}

func AgentUploadSkill(ctx *gonvex.MutationCtx, args AgentSaveSkillArgs) (Skill, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeSkillsWrite)
	if err != nil {
		return Skill{}, err
	}
	return saveSkill(ctx.Context, mutationRunner(ctx), ownerID, args.ID, args.Name, args.Summary, args.Content, false, "")
}

func AgentDeleteSkill(ctx *gonvex.MutationCtx, args AgentSkillArgs) (DeleteResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeSkillsWrite)
	if err != nil {
		return DeleteResult{}, err
	}
	return deleteSkill(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func AgentListAPIKeys(ctx *gonvex.QueryCtx, args AgentSkillArgs) ([]APIKeyRecord, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeKeysRead)
	if err != nil {
		return nil, err
	}
	return listAPIKeys(ctx.Context, ctx.DB, ownerID)
}

func AgentVerifyAPIKey(ctx *gonvex.QueryCtx, args AgentSkillArgs) (DeleteResult, error) {
	_, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, "")
	if err != nil {
		return DeleteResult{}, err
	}
	return DeleteResult{Deleted: true}, nil
}

func AgentRevokeAPIKey(ctx *gonvex.MutationCtx, args AgentRevokeAPIKeyArgs) (DeleteResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeKeysRevoke)
	if err != nil {
		return DeleteResult{}, err
	}
	return revokeAPIKey(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func AgentRevokeSelf(ctx *gonvex.MutationCtx, args AgentSkillArgs) (DeleteResult, error) {
	apiKey := strings.TrimSpace(args.APIKey)
	if apiKey == "" {
		return DeleteResult{}, errors.New("api key is required")
	}
	if len(apiKey) > 256 {
		return DeleteResult{}, errors.New("invalid api key")
	}
	if err := ensureTables(ctx.Context, mutationRunner(ctx)); err != nil {
		return DeleteResult{}, err
	}
	result, err := mutationRunner(ctx).ExecContext(ctx.Context, `
		update skill_api_keys set revoked_at = now()
		where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
	`, hashToken(apiKey))
	if err != nil {
		return DeleteResult{}, err
	}
	count, _ := result.RowsAffected()
	return DeleteResult{Deleted: count > 0}, nil
}

func AgentListCredentials(ctx *gonvex.QueryCtx, args AgentSkillArgs) ([]CredentialMeta, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeCredentialsRead)
	if err != nil {
		return nil, err
	}
	return listCredentialMeta(ctx.Context, ctx.DB, ownerID)
}

func AgentGetCredential(ctx *gonvex.QueryCtx, args AgentSkillArgs) (Credential, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeCredentialsRead)
	if err != nil {
		return Credential{}, err
	}
	keys := credentialKeyConfig{
		Current:  ctx.EnvValue("SKILLS_SECRET_KEY"),
		Previous: ctx.EnvValue("SKILLS_SECRET_KEY_PREVIOUS"),
	}
	return getCredential(ctx.Context, ctx.DB, ownerID, args.ID, args.Name, keys)
}

func getCredential(ctx context.Context, db *sql.DB, ownerID string, id string, name string, keys credentialKeyConfig) (Credential, error) {
	if db == nil {
		return Credential{}, errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return Credential{}, err
	}
	row := db.QueryRowContext(ctx, `
		select id, name, summary, secret_value, created_at, updated_at
		from skill_credentials
		where owner_id = $1 and (($2 <> '' and id = $2) or ($3 <> '' and lower(name) = lower($3)))
		order by updated_at desc
		limit 1
	`, ownerID, strings.TrimSpace(id), strings.TrimSpace(name))
	var credential Credential
	if err := row.Scan(&credential.ID, &credential.Name, &credential.Summary, &credential.Value, &credential.CreatedAt, &credential.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Credential{}, errors.New("credential not found")
		}
		return Credential{}, err
	}
	value, migrate, err := decryptSecret(keys, ownerID, credential.ID, credential.Value)
	if err != nil {
		return Credential{}, err
	}
	if migrate {
		stored, err := encryptSecret(keys, ownerID, credential.ID, value)
		if err != nil {
			return Credential{}, err
		}
		if _, err := db.ExecContext(ctx, `update skill_credentials set secret_value = $1 where owner_id = $2 and id = $3`, stored, ownerID, credential.ID); err != nil {
			return Credential{}, fmt.Errorf("migrate credential encryption: %w", err)
		}
	}
	credential.Value = value
	return credential, nil
}

func AgentSaveCredential(ctx *gonvex.MutationCtx, args AgentSaveCredentialArgs) (CredentialMeta, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeCredentialsWrite)
	if err != nil {
		return CredentialMeta{}, err
	}
	keys := credentialKeyConfig{
		Current:  ctx.EnvValue("SKILLS_SECRET_KEY"),
		Previous: ctx.EnvValue("SKILLS_SECRET_KEY_PREVIOUS"),
	}
	return saveCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID, args.Name, args.Summary, args.Value, keys)
}

func AgentDeleteCredential(ctx *gonvex.MutationCtx, args AgentDeleteCredentialArgs) (DeleteResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey, scopeCredentialsWrite)
	if err != nil {
		return DeleteResult{}, err
	}
	return deleteCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

// listSkills intentionally returns metadata only; fetch content per skill via
// skills.get / agent.skills.get so lists stay cheap as the vault grows.
func listSkills(ctx context.Context, db *sql.DB, ownerID string, approvedOnly bool) ([]SkillMeta, error) {
	if db == nil {
		return []SkillMeta{}, nil
	}
	if err := ensureTables(ctx, db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
		select id, name, summary, created_at, updated_at, approved_at is not null
		from skills
		where owner_id = $1 and (not $2 or approved_at is not null)
		order by lower(name), updated_at desc
	`, ownerID, approvedOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byKey := map[string]SkillMeta{}
	for rows.Next() {
		var skill SkillMeta
		if err := rows.Scan(&skill.ID, &skill.Name, &skill.Summary, &skill.CreatedAt, &skill.UpdatedAt, &skill.Approved); err != nil {
			return nil, err
		}
		key := skillIdentityKey(skill.ID, skill.Name)
		if current, ok := byKey[key]; !ok || skill.UpdatedAt.After(current.UpdatedAt) {
			byKey[key] = skill
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	skills := make([]SkillMeta, 0, len(byKey))
	for _, skill := range byKey {
		skills = append(skills, skill)
	}
	sort.Slice(skills, func(i, j int) bool {
		left := strings.ToLower(skills[i].Name)
		right := strings.ToLower(skills[j].Name)
		if left == right {
			return skills[i].UpdatedAt.After(skills[j].UpdatedAt)
		}
		return left < right
	})
	return skills, nil
}

func getSkill(ctx context.Context, db execQueryer, ownerID string, id string, name string, approvedOnly bool) (Skill, error) {
	if db == nil {
		return Skill{}, errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return Skill{}, err
	}
	row := db.QueryRowContext(ctx, `
		select id, name, summary, content, created_at, updated_at, approved_at is not null
		from skills
		where owner_id = $1 and (($2 <> '' and id = $2) or ($3 <> '' and lower(name) = lower($3)))
			and (not $4 or approved_at is not null)
		order by updated_at desc
		limit 1
	`, ownerID, strings.TrimSpace(id), strings.TrimSpace(name), approvedOnly)
	var skill Skill
	if err := row.Scan(&skill.ID, &skill.Name, &skill.Summary, &skill.Content, &skill.CreatedAt, &skill.UpdatedAt, &skill.Approved); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Skill{}, errors.New("skill not found")
		}
		return Skill{}, err
	}
	return skill, nil
}

func saveSkill(ctx context.Context, runner execQueryer, ownerID string, id string, name string, summary string, content string, approved bool, approvedBy string) (Skill, error) {
	name = strings.TrimSpace(name)
	content = strings.TrimSpace(content)
	if name == "" {
		return Skill{}, errors.New("skill name is required")
	}
	if content == "" {
		return Skill{}, errors.New("skill content is required")
	}
	if len(name) > maxNameLength || len(summary) > maxSummaryLength {
		return Skill{}, errors.New("skill name or summary exceeds the allowed length")
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 || strings.IndexFunc(summary, unicode.IsControl) >= 0 {
		return Skill{}, errors.New("skill name or summary contains control characters")
	}
	if len(content) > maxSkillContentBytes {
		return Skill{}, fmt.Errorf("skill content exceeds the %d-byte limit", maxSkillContentBytes)
	}
	if err := ensureTables(ctx, runner); err != nil {
		return Skill{}, err
	}

	id = strings.TrimSpace(id)
	now := time.Now().UTC()
	if id == "" {
		nextID, err := randomID()
		if err != nil {
			return Skill{}, err
		}
		id = nextID
	}
	if len(id) > 240 {
		return Skill{}, errors.New("skill id is too long")
	}
	id = existingSkillID(ctx, runner, ownerID, id, name)
	var exists bool
	if err := runner.QueryRowContext(ctx, `select exists(select 1 from skills where owner_id = $1 and id = $2)`, ownerID, id).Scan(&exists); err != nil {
		return Skill{}, err
	}
	if !exists {
		var count int
		if err := runner.QueryRowContext(ctx, `select count(*) from skills where owner_id = $1`, ownerID).Scan(&count); err != nil {
			return Skill{}, err
		}
		if count >= maxWorkspaceSkills {
			return Skill{}, fmt.Errorf("workspace skill limit reached (%d)", maxWorkspaceSkills)
		}
	}
	var approvedAt *time.Time
	if approved {
		approvedAt = &now
	}
	var createdAt time.Time
	err := runner.QueryRowContext(ctx, `
		insert into skills (id, owner_id, name, summary, content, content_hash, approved_at, approved_by, created_at, updated_at)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
		on conflict (id) do update set
			name = excluded.name,
			summary = excluded.summary,
			content = excluded.content,
			content_hash = excluded.content_hash,
			approved_at = excluded.approved_at,
			approved_by = excluded.approved_by,
			updated_at = excluded.updated_at
		returning created_at
	`, id, ownerID, name, strings.TrimSpace(summary), content, hashToken(content), approvedAt, approvedBy, now).Scan(&createdAt)
	if err != nil {
		return Skill{}, err
	}
	return Skill{
		SkillMeta: SkillMeta{ID: id, Name: name, Summary: strings.TrimSpace(summary), CreatedAt: createdAt, UpdatedAt: now, Approved: approved},
		Content:   content,
	}, nil
}

func existingSkillID(ctx context.Context, runner execer, ownerID string, id string, name string) string {
	scoped := scopedID(ownerID, id)
	q, ok := runner.(queryer)
	if !ok {
		return scoped
	}
	var existing string
	err := q.QueryRowContext(ctx, `
		select id
		from skills
		where owner_id = $1 and (
			id = $2
			or id = $3
			or lower(name) = lower($4)
		)
		order by
			case
				when id = $2 then 0
				when lower(name) = lower($4) then 1
				when id = $3 then 2
				else 3
			end,
			updated_at desc
		limit 1
	`, ownerID, scoped, id, name).Scan(&existing)
	if err == nil && strings.TrimSpace(existing) != "" {
		return existing
	}
	return scoped
}

func skillIdentityKey(skillID string, skillName string) string {
	id := strings.TrimSpace(skillID)
	if index := strings.Index(id, "_"); index == 12 && len(id) > 13 {
		id = id[index+1:]
	}
	id = strings.TrimPrefix(id, "local-")
	id = strings.TrimPrefix(id, "cloud-")
	if id != "" {
		return strings.ToLower(id)
	}
	return strings.ToLower(strings.TrimSpace(skillName))
}

func deleteSkill(ctx context.Context, runner execer, ownerID string, id string) (DeleteResult, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return DeleteResult{}, errors.New("skill id is required")
	}
	if err := ensureTables(ctx, runner); err != nil {
		return DeleteResult{}, err
	}
	result, err := runner.ExecContext(ctx, `delete from skills where owner_id = $1 and id = $2`, ownerID, id)
	if err != nil {
		return DeleteResult{}, err
	}
	count, _ := result.RowsAffected()
	return DeleteResult{Deleted: count > 0}, nil
}

func listCredentialMeta(ctx context.Context, db *sql.DB, ownerID string) ([]CredentialMeta, error) {
	if db == nil {
		return []CredentialMeta{}, nil
	}
	if err := ensureTables(ctx, db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
		select id, name, summary, created_at, updated_at
		from skill_credentials
		where owner_id = $1
		order by lower(name), updated_at desc
	`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byName := map[string]CredentialMeta{}
	for rows.Next() {
		var credential CredentialMeta
		if err := rows.Scan(&credential.ID, &credential.Name, &credential.Summary, &credential.CreatedAt, &credential.UpdatedAt); err != nil {
			return nil, err
		}
		key := strings.ToLower(strings.TrimSpace(credential.Name))
		if current, ok := byName[key]; !ok || credential.UpdatedAt.After(current.UpdatedAt) {
			byName[key] = credential
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	credentials := make([]CredentialMeta, 0, len(byName))
	for _, credential := range byName {
		credentials = append(credentials, credential)
	}
	sort.Slice(credentials, func(i, j int) bool {
		left := strings.ToLower(credentials[i].Name)
		right := strings.ToLower(credentials[j].Name)
		if left == right {
			return credentials[i].UpdatedAt.After(credentials[j].UpdatedAt)
		}
		return left < right
	})
	return credentials, nil
}

func existingCredentialID(ctx context.Context, runner execer, ownerID string, id string, name string) string {
	scoped := scopedID(ownerID, id)
	q, ok := runner.(queryer)
	if !ok {
		return scoped
	}
	var existing string
	err := q.QueryRowContext(ctx, `
		select id
		from skill_credentials
		where owner_id = $1 and (
			id = $2
			or id = $3
			or lower(btrim(name)) = lower($4)
		)
		order by
			case
				when id = $2 then 0
				when lower(btrim(name)) = lower($4) then 1
				when id = $3 then 2
				else 3
			end,
			updated_at desc
		limit 1
	`, ownerID, scoped, strings.TrimSpace(id), strings.TrimSpace(name)).Scan(&existing)
	if err == nil && strings.TrimSpace(existing) != "" {
		return existing
	}
	return scoped
}

func mutationRunner(ctx *gonvex.MutationCtx) execQueryer {
	if ctx.Tx != nil {
		return ctx.Tx
	}
	return ctx.DB
}

// ensureTablesDone skips schema DDL after the first successful run so every
// query/mutation is not paying for ~20 idempotent statements.
var ensureTablesDone atomic.Bool
var ensureTablesMu sync.Mutex

func ensureTables(ctx context.Context, db execer) error {
	if db == nil {
		return errors.New("database is not configured")
	}
	if ensureTablesDone.Load() {
		return nil
	}
	ensureTablesMu.Lock()
	defer ensureTablesMu.Unlock()
	if ensureTablesDone.Load() {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	statements := []string{
		`create table if not exists skill_users (
			owner_id text primary key,
			email text not null,
			name text not null default '',
			can_own boolean not null default false,
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now()
		)`,
		`create table if not exists skills (
			id text primary key,
			owner_id text not null default '',
			name text not null,
			summary text not null default '',
			content text not null,
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now(),
			content_hash text not null default '',
			approved_at timestamptz,
			approved_by text not null default ''
		)`,
		`create table if not exists skill_api_keys (
			id text primary key,
			owner_id text not null default '',
			created_by text not null default '',
			name text not null,
			key_hash text not null unique,
			prefix text not null,
			scopes text not null default 'skills:read,skills:write,credentials:read,credentials:write,keys:read,keys:revoke',
			created_at timestamptz not null default now(),
			expires_at timestamptz default (now() + interval '30 days'),
			revoked_at timestamptz
		)`,
		`create table if not exists skill_sessions (
			id text primary key,
			owner_id text not null default '',
			workspace_id text not null default '',
			token_hash text not null unique,
			pending_only boolean not null default false,
			created_at timestamptz not null default now(),
			expires_at timestamptz not null,
			revoked_at timestamptz
		)`,
		`create table if not exists skill_credentials (
			id text primary key,
			owner_id text not null default '',
			name text not null,
			summary text not null default '',
			secret_value text not null,
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now()
		)`,
		`create table if not exists skill_workspace_members (
			id text primary key,
			workspace_owner_id text not null,
			email text not null,
			invited_by text not null default '',
			created_at timestamptz not null default now()
		)`,
		`create table if not exists skill_workspace_invitations (
			id text primary key,
			workspace_owner_id text not null,
			email text not null,
			invited_by text not null default '',
			created_at timestamptz not null default now(),
			accepted_at timestamptz,
			rejected_at timestamptz
		)`,
		`alter table skills add column if not exists owner_id text not null default ''`,
		`alter table skill_users add column if not exists can_own boolean not null default false`,
		`alter table skills add column if not exists content_hash text not null default ''`,
		`alter table skills add column if not exists approved_at timestamptz`,
		`alter table skills add column if not exists approved_by text not null default ''`,
		`alter table skill_api_keys add column if not exists owner_id text not null default ''`,
		`alter table skill_api_keys add column if not exists created_by text not null default ''`,
		`alter table skill_api_keys add column if not exists scopes text not null default 'skills:read,skills:write,credentials:read,credentials:write,keys:read,keys:revoke'`,
		`alter table skill_api_keys add column if not exists expires_at timestamptz not null default (now() + interval '30 days')`,
		`alter table skill_api_keys alter column expires_at drop not null`,
		`alter table skill_sessions add column if not exists owner_id text not null default ''`,
		`alter table skill_sessions add column if not exists workspace_id text not null default ''`,
		`alter table skill_sessions add column if not exists pending_only boolean not null default false`,
		`alter table skill_credentials add column if not exists owner_id text not null default ''`,
		`update skill_api_keys set created_by = owner_id where created_by = ''`,
		`update skills set approved_at = created_at, approved_by = owner_id, content_hash = md5(content) where approved_at is null and approved_by = '' and content_hash = ''`,
		`create index if not exists skills_by_owner_name on skills(owner_id, lower(name))`,
		`create index if not exists skills_by_owner_updated_at on skills(owner_id, updated_at)`,
		`create index if not exists skill_api_keys_by_owner_created_at on skill_api_keys(owner_id, created_at)`,
		`create index if not exists skill_sessions_by_owner_token_hash on skill_sessions(owner_id, token_hash)`,
		`create index if not exists skill_credentials_by_owner_name on skill_credentials(owner_id, lower(name))`,
		`delete from skill_credentials as stale
			using skill_credentials as current
			where stale.owner_id = current.owner_id
				and lower(btrim(stale.name)) = lower(btrim(current.name))
				and (
					stale.updated_at < current.updated_at
					or (stale.updated_at = current.updated_at and stale.id < current.id)
				)`,
		`create unique index if not exists skill_credentials_unique_owner_name on skill_credentials(owner_id, lower(btrim(name)))`,
		`create unique index if not exists skill_workspace_members_unique on skill_workspace_members(workspace_owner_id, email)`,
		`create unique index if not exists skill_workspace_invitations_pending_unique on skill_workspace_invitations(workspace_owner_id, email) where accepted_at is null and rejected_at is null`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	ensureTablesDone.Store(true)
	return nil
}

type sessionIdentity struct {
	OwnerID     string
	WorkspaceID string
	PendingOnly bool
}

func (s sessionIdentity) IsWorkspaceOwner() bool {
	return s.OwnerID == s.WorkspaceID && !s.PendingOnly
}

// verifySession returns the workspace id the session may read and write.
// For invited team members this is the inviter's workspace, not their own id.
func verifySession(ctx context.Context, db *sql.DB, token string) (string, error) {
	identity, err := verifySessionIdentity(ctx, db, token)
	if err != nil {
		return "", err
	}
	if identity.PendingOnly {
		return "", errors.New("accept or reject the pending workspace invitation first")
	}
	return identity.WorkspaceID, nil
}

func verifySessionIdentity(ctx context.Context, db *sql.DB, token string) (sessionIdentity, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return sessionIdentity{}, errors.New("session token is required")
	}
	if len(token) > 256 {
		return sessionIdentity{}, errors.New("invalid session")
	}
	if db == nil {
		return sessionIdentity{}, errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return sessionIdentity{}, err
	}
	var ownerID, workspaceID string
	var pendingOnly bool
	err := db.QueryRowContext(ctx, `
		select owner_id, coalesce(workspace_id, ''), pending_only
		from skill_sessions
		where token_hash = $1 and revoked_at is null and expires_at > now()
		limit 1
	`, hashToken(token)).Scan(&ownerID, &workspaceID, &pendingOnly)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return sessionIdentity{}, errors.New("invalid session")
		}
		return sessionIdentity{}, err
	}
	if strings.TrimSpace(ownerID) == "" {
		return sessionIdentity{}, errors.New("invalid session owner")
	}
	if strings.TrimSpace(workspaceID) == "" {
		workspaceID = ownerID
	}
	if workspaceID != ownerID && !pendingOnly {
		var active bool
		err := db.QueryRowContext(ctx, `
			select exists(
				select 1 from skill_workspace_members m
				join skill_users u on u.owner_id = $1
				where m.workspace_owner_id = $2 and lower(m.email) = lower(u.email)
			)
		`, ownerID, workspaceID).Scan(&active)
		if err != nil {
			return sessionIdentity{}, err
		}
		if !active {
			return sessionIdentity{}, errors.New("workspace membership is no longer active")
		}
	}
	return sessionIdentity{OwnerID: ownerID, WorkspaceID: workspaceID, PendingOnly: pendingOnly}, nil
}

func verifyAPIKey(ctx context.Context, db *sql.DB, apiKey string, requiredScope string) (string, error) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return "", errors.New("api key is required")
	}
	if len(apiKey) > 256 {
		return "", errors.New("invalid api key")
	}
	if db == nil {
		return "", errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return "", err
	}
	var ownerID, createdBy, scopes string
	err := db.QueryRowContext(ctx, `
		select owner_id, created_by, scopes
		from skill_api_keys
		where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
		limit 1
	`, hashToken(apiKey)).Scan(&ownerID, &createdBy, &scopes)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("invalid api key")
		}
		return "", err
	}
	if strings.TrimSpace(ownerID) == "" {
		return "", errors.New("invalid api key owner")
	}
	if requiredScope != "" && !scopeAllowed(scopes, requiredScope) {
		return "", fmt.Errorf("api key is missing required scope %s", requiredScope)
	}
	if createdBy != "" && createdBy != ownerID {
		var active bool
		if err := db.QueryRowContext(ctx, `
			select exists(
				select 1 from skill_workspace_members m
				join skill_users u on u.owner_id = $1
				where m.workspace_owner_id = $2 and lower(m.email) = lower(u.email)
			)
		`, createdBy, ownerID).Scan(&active); err != nil {
			return "", err
		}
		if !active {
			return "", errors.New("api key creator is no longer a workspace member")
		}
	}
	return ownerID, nil
}

func normalizeScopes(requested []string) ([]string, error) {
	allowed := map[string]bool{
		scopeSkillsRead: true, scopeSkillsWrite: true,
		scopeCredentialsRead: true, scopeCredentialsWrite: true,
		scopeKeysRead: true, scopeKeysRevoke: true,
	}
	unique := map[string]bool{}
	for _, scope := range requested {
		scope = strings.ToLower(strings.TrimSpace(scope))
		if scope == "" {
			continue
		}
		if !allowed[scope] {
			return nil, fmt.Errorf("unsupported api key scope %q", scope)
		}
		unique[scope] = true
	}
	result := make([]string, 0, len(unique))
	for scope := range unique {
		result = append(result, scope)
	}
	sort.Strings(result)
	return result, nil
}

func scopeAllowed(scopes string, required string) bool {
	for _, scope := range splitCSV(scopes) {
		if scope == required {
			return true
		}
	}
	return false
}

func verifyGoogleIDToken(ctx context.Context, idToken string) (googleTokenInfo, error) {
	if strings.TrimSpace(idToken) == "" {
		return googleTokenInfo{}, errors.New("google id token is required")
	}
	clientID := strings.TrimSpace(os.Getenv("SKILLS_GOOGLE_CLIENT_ID"))
	if clientID == "" {
		clientID = defaultGoogleClientID
	}
	endpoint := "https://oauth2.googleapis.com/tokeninfo?id_token=" + url.QueryEscape(strings.TrimSpace(idToken))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return googleTokenInfo{}, err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return googleTokenInfo{}, fmt.Errorf("verify google token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return googleTokenInfo{}, errors.New("google token verification failed")
	}
	var info googleTokenInfo
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&info); err != nil {
		return googleTokenInfo{}, err
	}
	if info.Audience != clientID {
		return googleTokenInfo{}, errors.New("google token audience mismatch")
	}
	if strings.TrimSpace(info.Subject) == "" || strings.TrimSpace(info.Email) == "" {
		return googleTokenInfo{}, errors.New("google token missing identity")
	}
	if strings.ToLower(info.EmailVerified) != "true" {
		return googleTokenInfo{}, errors.New("google email is not verified")
	}
	return info, nil
}

func identityAllowed(info googleTokenInfo) bool {
	email := strings.ToLower(strings.TrimSpace(info.Email))
	domain := ""
	if at := strings.LastIndex(email, "@"); at >= 0 && at+1 < len(email) {
		domain = email[at+1:]
	}
	allowedEmails := splitCSV(os.Getenv("SKILLS_ALLOWED_EMAILS"))
	allowedDomains := splitCSV(os.Getenv("SKILLS_ALLOWED_DOMAINS"))
	if len(allowedEmails) == 0 && len(allowedDomains) == 0 {
		allowedEmails = []string{defaultAllowedEmail}
	}
	for _, allowed := range allowedEmails {
		if email == strings.ToLower(allowed) {
			return true
		}
	}
	for _, allowed := range allowedDomains {
		allowed = strings.ToLower(strings.TrimPrefix(allowed, "@"))
		if domain == allowed || strings.ToLower(strings.TrimSpace(info.HostedDomain)) == allowed {
			return true
		}
	}
	return false
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func upsertUser(ctx context.Context, runner execer, ownerID string, email string, name string, canOwn bool) error {
	_, err := runner.ExecContext(ctx, `
		insert into skill_users (owner_id, email, name, can_own, created_at, updated_at)
		values ($1, $2, $3, $4, now(), now())
		on conflict (owner_id) do update set
			email = excluded.email,
			name = excluded.name,
			can_own = excluded.can_own,
			updated_at = excluded.updated_at
	`, ownerID, email, name, canOwn)
	return err
}

func claimLegacyRows(ctx context.Context, runner execer, ownerID string, email string) error {
	legacyEmail := strings.ToLower(strings.TrimSpace(os.Getenv("SKILLS_LEGACY_OWNER_EMAIL")))
	legacyOwnerID := strings.TrimSpace(os.Getenv("SKILLS_LEGACY_OWNER_ID"))
	if legacyEmail == "" && legacyOwnerID == "" {
		return nil
	}
	if legacyEmail != "" && strings.ToLower(strings.TrimSpace(email)) != legacyEmail {
		return nil
	}
	if legacyOwnerID != "" && ownerID != legacyOwnerID {
		return nil
	}
	statements := []string{
		`update skills set owner_id = $1 where owner_id = ''`,
		`update skill_api_keys set owner_id = $1, created_by = $1 where owner_id = ''`,
		`update skill_credentials set owner_id = $1 where owner_id = ''`,
	}
	for _, statement := range statements {
		if _, err := runner.ExecContext(ctx, statement, ownerID); err != nil {
			return err
		}
	}
	return nil
}

func scopedID(ownerID string, id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return id
	}
	prefix := hashToken(ownerID)[:12] + "_"
	if strings.HasPrefix(id, prefix) {
		return id
	}
	return prefix + id
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// encv2 binds ciphertext to its workspace and credential id using GCM AAD.
// SKILLS_SECRET_KEY_PREVIOUS may contain comma-separated prior 256-bit keys
// during rotation. Plaintext and encv1 rows are migrated when read.
const (
	encryptedValuePrefix       = "encv2:"
	legacyEncryptedValuePrefix = "encv1:"
)

type credentialCipher struct {
	id   string
	aead cipher.AEAD
}

type credentialKeyConfig struct {
	Current  string
	Previous string
}

func decodeCredentialKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("credential encryption key is empty")
	}
	decoders := []func(string) ([]byte, error){
		hex.DecodeString,
		base64.StdEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
	}
	for _, decode := range decoders {
		if key, err := decode(raw); err == nil && len(key) == 32 {
			return key, nil
		}
	}
	return nil, errors.New("credential encryption keys must be exactly 32 bytes encoded as hex or base64")
}

func newCredentialCipher(raw string) (credentialCipher, error) {
	key, err := decodeCredentialKey(raw)
	if err != nil {
		return credentialCipher{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return credentialCipher{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return credentialCipher{}, err
	}
	return credentialCipher{id: hashToken(string(key))[:12], aead: aead}, nil
}

func credentialCiphers(config credentialKeyConfig) ([]credentialCipher, error) {
	current := strings.TrimSpace(config.Current)
	if current == "" {
		current = strings.TrimSpace(os.Getenv("SKILLS_SECRET_KEY"))
	}
	if current == "" {
		return nil, errors.New("SKILLS_SECRET_KEY must be configured before credentials can be stored or read")
	}
	previous := strings.TrimSpace(config.Previous)
	if previous == "" {
		previous = os.Getenv("SKILLS_SECRET_KEY_PREVIOUS")
	}
	rawKeys := append([]string{current}, splitCSV(previous)...)
	result := make([]credentialCipher, 0, len(rawKeys))
	seen := map[string]bool{}
	for _, raw := range rawKeys {
		item, err := newCredentialCipher(raw)
		if err != nil {
			return nil, err
		}
		if !seen[item.id] {
			seen[item.id] = true
			result = append(result, item)
		}
	}
	return result, nil
}

func credentialAAD(ownerID, credentialID string) []byte {
	return []byte("whagons-skills/credential/" + ownerID + "/" + credentialID)
}

func encryptSecret(config credentialKeyConfig, ownerID, credentialID, value string) (string, error) {
	ciphers, err := credentialCiphers(config)
	if err != nil {
		return "", err
	}
	current := ciphers[0]
	nonce := make([]byte, current.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	sealed := current.aead.Seal(nonce, nonce, []byte(value), credentialAAD(ownerID, credentialID))
	return encryptedValuePrefix + current.id + ":" + base64.RawStdEncoding.EncodeToString(sealed), nil
}

func decryptSecret(config credentialKeyConfig, ownerID, credentialID, value string) (string, bool, error) {
	ciphers, err := credentialCiphers(config)
	if err != nil {
		return "", false, err
	}
	if strings.HasPrefix(value, encryptedValuePrefix) {
		parts := strings.SplitN(value, ":", 3)
		if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
			return "", false, errors.New("encrypted credential is malformed")
		}
		sealed, err := base64.RawStdEncoding.DecodeString(parts[2])
		if err != nil {
			return "", false, errors.New("encrypted credential is malformed")
		}
		for index, item := range ciphers {
			if item.id != parts[1] || len(sealed) < item.aead.NonceSize() {
				continue
			}
			plain, err := item.aead.Open(nil, sealed[:item.aead.NonceSize()], sealed[item.aead.NonceSize():], credentialAAD(ownerID, credentialID))
			if err == nil {
				return string(plain), index != 0, nil
			}
		}
		return "", false, errors.New("credential decryption failed")
	}
	if strings.HasPrefix(value, legacyEncryptedValuePrefix) {
		sealed, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(value, legacyEncryptedValuePrefix))
		if err != nil {
			return "", false, errors.New("legacy encrypted credential is malformed")
		}
		for _, item := range ciphers {
			if len(sealed) < item.aead.NonceSize() {
				continue
			}
			plain, err := item.aead.Open(nil, sealed[:item.aead.NonceSize()], sealed[item.aead.NonceSize():], nil)
			if err == nil {
				return string(plain), true, nil
			}
		}
		return "", false, errors.New("legacy credential decryption failed")
	}
	return value, true, nil
}

func randomID() (string, error) {
	return randomToken("skill_")
}

func mustRandomID() string {
	id, err := randomID()
	if err != nil {
		return fmt.Sprintf("skill_%d", time.Now().UnixNano())
	}
	return id
}

func randomToken(prefix string) (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(bytes), nil
}
