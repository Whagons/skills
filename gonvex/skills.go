package backend

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gonvex/gonvex/pkg/gonvex"
)

const sessionTTL = 30 * 24 * time.Hour
const defaultGoogleClientID = "578623964983-iall0oeq2r2mke7trpqqv3pjingqljh0.apps.googleusercontent.com"
const defaultAllowedEmail = "malek.gabriel33@gmail.com"

type SessionArgs struct {
	SessionToken string `json:"sessionToken"`
}

type LoginArgs struct {
	Password string `json:"password"`
	IDToken  string `json:"idToken"`
}

type LoginResult struct {
	SessionToken string    `json:"sessionToken"`
	ExpiresAt    time.Time `json:"expires_at"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
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

type AgentCreateAPIKeyArgs struct {
	APIKey string `json:"apiKey"`
	Name   string `json:"name"`
}

type AgentRevokeAPIKeyArgs struct {
	APIKey string `json:"apiKey"`
	ID     string `json:"id"`
}

type CreateAPIKeyArgs struct {
	SessionToken string `json:"sessionToken"`
	Name         string `json:"name"`
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

type Skill struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Summary   string    `json:"summary"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
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

func Register(app *gonvex.App) {
	app.Mutation("auth.login", Login)
	app.Mutation("auth.logout", Logout)
	app.Query("skills.list", ListSkills)
	app.Mutation("skills.save", SaveSkill)
	app.Mutation("skills.delete", DeleteSkill)
	app.Query("apiKeys.list", ListAPIKeys)
	app.Mutation("apiKeys.create", CreateAPIKey)
	app.Mutation("apiKeys.revoke", RevokeAPIKey)
	app.Query("credentials.list", ListCredentials)
	app.Mutation("credentials.save", SaveCredential)
	app.Mutation("credentials.delete", DeleteCredential)
	app.Query("agent.skills.list", AgentListSkills)
	app.Query("agent.skills.get", AgentGetSkill)
	app.Mutation("agent.skills.upload", AgentUploadSkill)
	app.Mutation("agent.skills.delete", AgentDeleteSkill)
	app.Query("agent.apiKeys.list", AgentListAPIKeys)
	app.Mutation("agent.apiKeys.create", AgentCreateAPIKey)
	app.Mutation("agent.apiKeys.revoke", AgentRevokeAPIKey)
	app.Query("agent.credentials.list", AgentListCredentials)
	app.Query("agent.credentials.get", AgentGetCredential)
	app.Mutation("agent.credentials.save", AgentSaveCredential)
	app.Mutation("agent.credentials.delete", AgentDeleteCredential)
}

func Login(ctx *gonvex.MutationCtx, args LoginArgs) (LoginResult, error) {
	if ctx.DB == nil {
		return LoginResult{}, errors.New("database is not configured")
	}
	runner := execer(ctx.DB)
	if ctx.Tx != nil {
		runner = ctx.Tx
	}
	if err := ensureTables(ctx.Context, runner); err != nil {
		return LoginResult{}, err
	}

	ownerID, email, name, err := loginIdentity(ctx.Context, args)
	if err != nil {
		return LoginResult{}, err
	}
	if err := upsertUser(ctx.Context, runner, ownerID, email, name); err != nil {
		return LoginResult{}, err
	}
	if err := claimLegacyRows(ctx.Context, runner, ownerID, email); err != nil {
		return LoginResult{}, err
	}

	token, err := randomToken("skv_sess_")
	if err != nil {
		return LoginResult{}, err
	}
	now := time.Now().UTC()
	expires := now.Add(sessionTTL)
	_, err = runner.ExecContext(ctx.Context, `
		insert into skill_sessions (id, owner_id, token_hash, created_at, expires_at)
		values ($1, $2, $3, $4, $5)
	`, mustRandomID(), ownerID, hashToken(token), now, expires)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{SessionToken: token, ExpiresAt: expires, Email: email, Name: name}, nil
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

func ListSkills(ctx *gonvex.QueryCtx, args SessionArgs) ([]Skill, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return nil, err
	}
	return listSkills(ctx.Context, ctx.DB, ownerID)
}

func SaveSkill(ctx *gonvex.MutationCtx, args SaveSkillArgs) (Skill, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return Skill{}, err
	}
	runner := mutationRunner(ctx)
	return saveSkill(ctx.Context, runner, ownerID, args.ID, args.Name, args.Summary, args.Content)
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
		select id, name, prefix, created_at, revoked_at
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
		if err := rows.Scan(&record.ID, &record.Name, &record.Prefix, &record.CreatedAt, &record.RevokedAt); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func CreateAPIKey(ctx *gonvex.MutationCtx, args CreateAPIKeyArgs) (CreateAPIKeyResult, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	return createAPIKey(ctx.Context, mutationRunner(ctx), ownerID, args.Name)
}

func createAPIKey(ctx context.Context, runner execer, ownerID string, keyName string) (CreateAPIKeyResult, error) {
	name := strings.TrimSpace(keyName)
	if name == "" {
		name = "Agent key"
	}
	if err := ensureTables(ctx, runner); err != nil {
		return CreateAPIKeyResult{}, err
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
		insert into skill_api_keys (id, owner_id, name, key_hash, prefix, created_at)
		values ($1, $2, $3, $4, $5, $6)
	`, id, ownerID, name, hashToken(apiKey), prefix, now)
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	return CreateAPIKeyResult{
		Record: APIKeyRecord{ID: id, Name: name, Prefix: prefix, CreatedAt: now},
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

func SaveCredential(ctx *gonvex.MutationCtx, args SaveCredentialArgs) (CredentialMeta, error) {
	ownerID, err := verifySession(ctx.Context, ctx.DB, args.SessionToken)
	if err != nil {
		return CredentialMeta{}, err
	}
	return saveCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID, args.Name, args.Summary, args.Value)
}

func saveCredential(ctx context.Context, runner execer, ownerID string, credentialID string, credentialName string, credentialSummary string, credentialValue string) (CredentialMeta, error) {
	name := strings.TrimSpace(credentialName)
	value := strings.TrimSpace(credentialValue)
	if name == "" {
		return CredentialMeta{}, errors.New("credential name is required")
	}
	if value == "" {
		return CredentialMeta{}, errors.New("credential value is required")
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
	id = scopedID(ownerID, id)
	now := time.Now().UTC()
	_, err := runner.ExecContext(ctx, `
		insert into skill_credentials (id, owner_id, name, summary, secret_value, created_at, updated_at)
		values ($1, $2, $3, $4, $5, $6, $6)
		on conflict (id) do update set
			name = excluded.name,
			summary = excluded.summary,
			secret_value = excluded.secret_value,
			updated_at = excluded.updated_at
	`, id, ownerID, name, strings.TrimSpace(credentialSummary), value, now)
	if err != nil {
		return CredentialMeta{}, err
	}
	return CredentialMeta{ID: id, Name: name, Summary: strings.TrimSpace(credentialSummary), CreatedAt: now, UpdatedAt: now}, nil
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

func AgentListSkills(ctx *gonvex.QueryCtx, args AgentSkillArgs) ([]Skill, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return nil, err
	}
	return listSkills(ctx.Context, ctx.DB, ownerID)
}

func AgentGetSkill(ctx *gonvex.QueryCtx, args AgentSkillArgs) (Skill, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return Skill{}, err
	}
	return getSkill(ctx.Context, ctx.DB, ownerID, args.ID, args.Name)
}

func AgentUploadSkill(ctx *gonvex.MutationCtx, args AgentSaveSkillArgs) (Skill, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return Skill{}, err
	}
	return saveSkill(ctx.Context, mutationRunner(ctx), ownerID, args.ID, args.Name, args.Summary, args.Content)
}

func AgentDeleteSkill(ctx *gonvex.MutationCtx, args AgentSkillArgs) (DeleteResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return DeleteResult{}, err
	}
	return deleteSkill(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func AgentListAPIKeys(ctx *gonvex.QueryCtx, args AgentSkillArgs) ([]APIKeyRecord, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return nil, err
	}
	return listAPIKeys(ctx.Context, ctx.DB, ownerID)
}

func AgentCreateAPIKey(ctx *gonvex.MutationCtx, args AgentCreateAPIKeyArgs) (CreateAPIKeyResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return CreateAPIKeyResult{}, err
	}
	return createAPIKey(ctx.Context, mutationRunner(ctx), ownerID, args.Name)
}

func AgentRevokeAPIKey(ctx *gonvex.MutationCtx, args AgentRevokeAPIKeyArgs) (DeleteResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return DeleteResult{}, err
	}
	return revokeAPIKey(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func AgentListCredentials(ctx *gonvex.QueryCtx, args AgentSkillArgs) ([]CredentialMeta, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return nil, err
	}
	return listCredentialMeta(ctx.Context, ctx.DB, ownerID)
}

func AgentGetCredential(ctx *gonvex.QueryCtx, args AgentSkillArgs) (Credential, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return Credential{}, err
	}
	if ctx.DB == nil {
		return Credential{}, errors.New("database is not configured")
	}
	if err := ensureTables(ctx.Context, ctx.DB); err != nil {
		return Credential{}, err
	}
	row := ctx.DB.QueryRowContext(ctx.Context, `
		select id, name, summary, secret_value, created_at, updated_at
		from skill_credentials
		where owner_id = $1 and (($2 <> '' and id = $2) or ($3 <> '' and lower(name) = lower($3)))
		order by updated_at desc
		limit 1
	`, ownerID, strings.TrimSpace(args.ID), strings.TrimSpace(args.Name))
	var credential Credential
	if err := row.Scan(&credential.ID, &credential.Name, &credential.Summary, &credential.Value, &credential.CreatedAt, &credential.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Credential{}, errors.New("credential not found")
		}
		return Credential{}, err
	}
	return credential, nil
}

func AgentSaveCredential(ctx *gonvex.MutationCtx, args AgentSaveCredentialArgs) (CredentialMeta, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return CredentialMeta{}, err
	}
	return saveCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID, args.Name, args.Summary, args.Value)
}

func AgentDeleteCredential(ctx *gonvex.MutationCtx, args AgentDeleteCredentialArgs) (DeleteResult, error) {
	ownerID, err := verifyAPIKey(ctx.Context, ctx.DB, args.APIKey)
	if err != nil {
		return DeleteResult{}, err
	}
	return deleteCredential(ctx.Context, mutationRunner(ctx), ownerID, args.ID)
}

func listSkills(ctx context.Context, db *sql.DB, ownerID string) ([]Skill, error) {
	if db == nil {
		return []Skill{}, nil
	}
	if err := ensureTables(ctx, db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
		select id, name, summary, content, created_at, updated_at
		from skills
		where owner_id = $1
		order by lower(name), updated_at desc
	`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	skills := []Skill{}
	for rows.Next() {
		var skill Skill
		if err := rows.Scan(&skill.ID, &skill.Name, &skill.Summary, &skill.Content, &skill.CreatedAt, &skill.UpdatedAt); err != nil {
			return nil, err
		}
		skills = append(skills, skill)
	}
	return skills, rows.Err()
}

func getSkill(ctx context.Context, db *sql.DB, ownerID string, id string, name string) (Skill, error) {
	if db == nil {
		return Skill{}, errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return Skill{}, err
	}
	row := db.QueryRowContext(ctx, `
		select id, name, summary, content, created_at, updated_at
		from skills
		where owner_id = $1 and (($2 <> '' and id = $2) or ($3 <> '' and lower(name) = lower($3)))
		order by updated_at desc
		limit 1
	`, ownerID, strings.TrimSpace(id), strings.TrimSpace(name))
	var skill Skill
	if err := row.Scan(&skill.ID, &skill.Name, &skill.Summary, &skill.Content, &skill.CreatedAt, &skill.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Skill{}, errors.New("skill not found")
		}
		return Skill{}, err
	}
	return skill, nil
}

func saveSkill(ctx context.Context, runner execer, ownerID string, id string, name string, summary string, content string) (Skill, error) {
	name = strings.TrimSpace(name)
	content = strings.TrimSpace(content)
	if name == "" {
		return Skill{}, errors.New("skill name is required")
	}
	if content == "" {
		return Skill{}, errors.New("skill content is required")
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
	id = scopedID(ownerID, id)
	_, err := runner.ExecContext(ctx, `
		insert into skills (id, owner_id, name, summary, content, created_at, updated_at)
		values ($1, $2, $3, $4, $5, $6, $6)
		on conflict (id) do update set
			name = excluded.name,
			summary = excluded.summary,
			content = excluded.content,
			updated_at = excluded.updated_at
	`, id, ownerID, name, strings.TrimSpace(summary), content, now)
	if err != nil {
		return Skill{}, err
	}
	return Skill{ID: id, Name: name, Summary: strings.TrimSpace(summary), Content: content, CreatedAt: now, UpdatedAt: now}, nil
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
	credentials := []CredentialMeta{}
	for rows.Next() {
		var credential CredentialMeta
		if err := rows.Scan(&credential.ID, &credential.Name, &credential.Summary, &credential.CreatedAt, &credential.UpdatedAt); err != nil {
			return nil, err
		}
		credentials = append(credentials, credential)
	}
	return credentials, rows.Err()
}

func mutationRunner(ctx *gonvex.MutationCtx) execer {
	if ctx.Tx != nil {
		return ctx.Tx
	}
	return ctx.DB
}

func ensureTables(ctx context.Context, db execer) error {
	if db == nil {
		return errors.New("database is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	statements := []string{
		`create table if not exists skill_users (
			owner_id text primary key,
			email text not null,
			name text not null default '',
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
			updated_at timestamptz not null default now()
		)`,
		`create table if not exists skill_api_keys (
			id text primary key,
			owner_id text not null default '',
			name text not null,
			key_hash text not null unique,
			prefix text not null,
			created_at timestamptz not null default now(),
			revoked_at timestamptz
		)`,
		`create table if not exists skill_sessions (
			id text primary key,
			owner_id text not null default '',
			token_hash text not null unique,
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
		`alter table skills add column if not exists owner_id text not null default ''`,
		`alter table skill_api_keys add column if not exists owner_id text not null default ''`,
		`alter table skill_sessions add column if not exists owner_id text not null default ''`,
		`alter table skill_credentials add column if not exists owner_id text not null default ''`,
		`create index if not exists skills_by_owner_name on skills(owner_id, lower(name))`,
		`create index if not exists skills_by_owner_updated_at on skills(owner_id, updated_at)`,
		`create index if not exists skill_api_keys_by_owner_created_at on skill_api_keys(owner_id, created_at)`,
		`create index if not exists skill_sessions_by_owner_token_hash on skill_sessions(owner_id, token_hash)`,
		`create index if not exists skill_credentials_by_owner_name on skill_credentials(owner_id, lower(name))`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func verifySession(ctx context.Context, db *sql.DB, token string) (string, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return "", errors.New("session token is required")
	}
	if db == nil {
		return "", errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return "", err
	}
	var ownerID string
	err := db.QueryRowContext(ctx, `
		select owner_id
		from skill_sessions
		where token_hash = $1 and revoked_at is null and expires_at > now()
		limit 1
	`, hashToken(token)).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("invalid session")
		}
		return "", err
	}
	if strings.TrimSpace(ownerID) == "" {
		return "", errors.New("invalid session owner")
	}
	return ownerID, nil
}

func verifyAPIKey(ctx context.Context, db *sql.DB, apiKey string) (string, error) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return "", errors.New("api key is required")
	}
	if db == nil {
		return "", errors.New("database is not configured")
	}
	if err := ensureTables(ctx, db); err != nil {
		return "", err
	}
	var ownerID string
	err := db.QueryRowContext(ctx, `select owner_id from skill_api_keys where key_hash = $1 and revoked_at is null limit 1`, hashToken(apiKey)).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("invalid api key")
		}
		return "", err
	}
	if strings.TrimSpace(ownerID) == "" {
		return "", errors.New("invalid api key owner")
	}
	return ownerID, nil
}

func loginIdentity(ctx context.Context, args LoginArgs) (string, string, string, error) {
	if strings.TrimSpace(args.IDToken) != "" {
		info, err := verifyGoogleIDToken(ctx, args.IDToken)
		if err != nil {
			return "", "", "", err
		}
		email := strings.ToLower(strings.TrimSpace(info.Email))
		name := strings.TrimSpace(info.Name)
		if name == "" {
			name = email
		}
		return "google:" + strings.TrimSpace(info.Subject), email, name, nil
	}

	passwordHash, err := configuredPasswordHash()
	if err != nil {
		return "", "", "", err
	}
	if hashPassword(args.Password) != passwordHash {
		return "", "", "", errors.New("invalid password")
	}
	email := strings.ToLower(strings.TrimSpace(os.Getenv("SKILLS_LEGACY_OWNER_EMAIL")))
	if email == "" {
		email = "legacy@skills.whagons.com"
	}
	ownerID := strings.TrimSpace(os.Getenv("SKILLS_LEGACY_OWNER_ID"))
	if ownerID == "" {
		ownerID = "legacy:" + hashToken(email)[:16]
	}
	return ownerID, email, "Legacy owner", nil
}

func verifyGoogleIDToken(ctx context.Context, idToken string) (googleTokenInfo, error) {
	clientID := strings.TrimSpace(os.Getenv("SKILLS_GOOGLE_CLIENT_ID"))
	if clientID == "" {
		clientID = defaultGoogleClientID
	}
	endpoint := "https://oauth2.googleapis.com/tokeninfo?id_token=" + url.QueryEscape(strings.TrimSpace(idToken))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return googleTokenInfo{}, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return googleTokenInfo{}, fmt.Errorf("verify google token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return googleTokenInfo{}, errors.New("google token verification failed")
	}
	var info googleTokenInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
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
	if !identityAllowed(info) {
		return googleTokenInfo{}, errors.New("google account is not allowed for this vault")
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

func upsertUser(ctx context.Context, runner execer, ownerID string, email string, name string) error {
	_, err := runner.ExecContext(ctx, `
		insert into skill_users (owner_id, email, name, created_at, updated_at)
		values ($1, $2, $3, now(), now())
		on conflict (owner_id) do update set
			email = excluded.email,
			name = excluded.name,
			updated_at = excluded.updated_at
	`, ownerID, email, name)
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
		`update skill_api_keys set owner_id = $1 where owner_id = ''`,
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

func hashPassword(password string) string {
	return hashToken(os.Getenv("SKILLS_PASSWORD_SALT") + ":" + password)
}

func configuredPasswordHash() (string, error) {
	if strings.TrimSpace(os.Getenv("SKILLS_PASSWORD_SALT")) == "" || strings.TrimSpace(os.Getenv("SKILLS_PASSWORD_HASH")) == "" {
		return "", errors.New("skills password is not configured")
	}
	return strings.TrimSpace(os.Getenv("SKILLS_PASSWORD_HASH")), nil
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
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
