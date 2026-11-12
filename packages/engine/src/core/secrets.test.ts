import { describe, expect, it } from 'vitest';
import {
  findSecrets,
  isSensitivePath,
  maskEmails,
  maskPrivate,
  maskPrivateReport,
  maskSecrets,
} from './secrets.ts';

describe('maskSecrets', () => {
  it.each([
    ['const key = "AKIAIOSFODNN7EXAMPLE";', 'AKIAIOSFODNN7EXAMPLE'],
    ['token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv', 'sk-ant-api03-abcdefghijklmnopqrstuv'],
    ['const password = "hunter2hunter2";', 'hunter2hunter2'],
    ["apiKey: 'Zx81-p0qL-77Ab-qq91'", 'Zx81-p0qL-77Ab-qq91'],
    ['SECRET_KEY_BASE=f00dfacecafe1234beef', 'f00dfacecafe1234beef'],
    ['postgres://app:Sup3rS3cret@db.internal:5432/app', 'Sup3rS3cret'],
  ])('masks %s', (input, secret) => {
    const { text, masked } = maskSecrets(input);
    expect(masked).toBeGreaterThan(0);
    expect(text).not.toContain(secret);
  });

  it.each([
    'const tokenType = "Bearer";',
    'const author = "Jane Example";',
    'retries: Number(env.WEATHER_MAX_RETRIES ?? DEFAULT_RETRY.retries),',
    'KEY_PREFIX=mergestory',
    'const password = process.env.DB_PASSWORD;',
    'export const API_KEY = "${API_KEY}";',
    "headers: { 'x-request-id': requestId },",
    'const sha = "3f9c2ab4e1d0c5b6a7f8e9d0c1b2a3f4e5d6c7b8";',
  ])('leaves ordinary code alone: %s', (input) => {
    expect(maskSecrets(input)).toEqual({ text: input, masked: 0 });
  });

  it.each([
    ['headers: { Authorization: "Bearer abcdef1234567890abcdef" }', 'abcdef1234567890abcdef', 'Bearer ••••'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'dXNlcjpwYXNzd29yZDEyMw', 'Basic ••••'],
    [
      'curl -H "X-Api-Key: 0123456789abcdef0123456789abcdef" https://api.example.com',
      '0123456789abcdef0123456789abcdef',
      'X-Api-Key: ••••',
    ],
    ['authorization: bearer abcdef1234567890abcdef', 'abcdef1234567890abcdef', 'bearer ••••'],
    ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop', 'Bearer ••••'],
    ['Bearer AbcdEfghIjklMnop', 'AbcdEfghIjklMnop', 'Bearer ••••'],
    ['authorization: basic dXNlcjpwYXNzd29yZDEyMw==', 'dXNlcjpwYXNzd29yZDEyMw', 'basic ••••'],
    ["'Authorization': 'Basic YWRtaW5hZG1pbg=='", 'YWRtaW5hZG1pbg', 'Basic ••••'],
  ])('masks the value of a key header and keeps its name: %s', (input, secret, kept) => {
    const { text, masked } = maskSecrets(input);
    expect(masked).toBe(1);
    expect(text).not.toContain(secret);
    expect(text).toContain(kept);
  });

  it('keeps prose about header schemes', () => {
    const input =
      'Clients send Basic authentication, Bearer authentication. Or Bearer authorization, or a token in the X-Api-Key header.';
    expect(maskSecrets(input)).toEqual({ text: input, masked: 0 });
  });

  it('stays fast on long runs that used to backtrack', () => {
    const inputs = [
      'a.a.'.repeat(16_384),
      'a-a-'.repeat(16_384),
      'password.'.repeat(8_000),
      'x'.repeat(65_536),
      `"${'A1b2'.repeat(4_000)}`,
      `postgres://${'u'.repeat(30_000)}:${'p'.repeat(30_000)}`,
      `password: ${'A'.repeat(100_000)} x`,
      `${' '.repeat(60_000)}password: x`,
      `password:${'\t'.repeat(60_000)}`,
      `client-key-data: ${'Ab1+'.repeat(16_000)}`,
      'p: Pr0dDbPassw0rd\n'.repeat(5_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      findSecrets(input);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe('maskSecrets: webhooks, URL tokens and long names', () => {
  // Made-up values, joined at run time so secret scanners do not flag the source.
  const fake = (...parts: string[]): string => parts.join('');
  const slackPath = 'T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
  it.each([
    [`"webhookUrl": "${fake('https://hooks.slack.com/services/', slackPath)}",`, slackPath],
    [`"url": "${fake('https:\\/\\/hooks.slack.com\\/services\\/', slackPath)}"`, 'XXXXXXXXXXXXXXXXXXXXXXXX'],
    [
      'hook: https://hooks.slack.com/workflows/T0000/A0000/123456789012345678/abcdEFGHijklMNOPqrst',
      'abcdEFGHijklMNOPqrst',
    ],
    [
      '"https://hooks.slack.com/triggers/T0000/123456789012/abcdef0123456789abcdef0123456789"',
      'abcdef0123456789abcdef',
    ],
    [
      fake(
        '"https://example.webhook.office.com/webhookb2/aaaa/IncomingWebhook/',
        '0123456789abcdef0123/dddd"',
      ),
      '0123456789abcdef0123',
    ],
    [
      fake('"https://discord.com/api/webhooks/', '123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"'),
      'AbCdEfGhIjKlMnOpQrSt0123',
    ],
    ['- https://example.com/notify?token=AbCdEf0123456789xyz&x=1', 'AbCdEf0123456789xyz'],
  ])('masks %s', (input, secret) => {
    const { text, masked } = maskSecrets(input);
    expect(masked).toBeGreaterThan(0);
    expect(text).not.toContain(secret);
  });

  it.each([
    'See https://docs.github.com/en/webhooks/about-webhooks for the payload.',
    'This removes `updateInvoiceApprovalStatusForCustomer` and `runNightlyReconciliationCleanupJob`.',
    "const handler = 'processIncomingWebhookPayloadForTenant';",
    'Script: `run_nightly_reconciliation_cleanup_job_v2`.',
  ])('leaves %s alone', (input) => {
    expect(maskSecrets(input)).toEqual({ text: input, masked: 0 });
  });

  it('still masks a random literal without a telling name', () => {
    expect(maskSecrets("const x = 'q8Zr2LmP0vXa7TnB4kYw9HsD3fGj6Ue1';").masked).toBe(1);
  });
});

describe('maskSecrets: unquoted values in configuration files', () => {
  // A base64 private key as kubeconfig holds it: one line, far longer than any other rule allows.
  const keyData = `LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQpNSUlFb3dJQkFBS0NBUUVB${'q7Zx9Kp2Lw4Rt6Yv8Nb1Mc3Hd5Fg0Js'.repeat(60)}`;

  it.each([
    ['YAML', '    password: Pr0dDbPassw0rd2026', 'Pr0dDbPassw0rd2026'],
    ['YAML, a plain word', '  db_password: supersecretvalue', 'supersecretvalue'],
    ['INI', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG'],
    ['Java properties', 'spring.datasource.password=MyP@ssw0rd', 'MyP@ssw0rd'],
    ['a compose list', '      - POSTGRES_PASSWORD=Pr0dPass2026', 'Pr0dPass2026'],
    ['a compose map', '      POSTGRES_PASSWORD: my_db_password', 'my_db_password'],
    ['a generated token', '  token: 8f9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', '8f9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'],
    ['a kubeconfig key', `    client-key-data: ${keyData}`, keyData.slice(-40)],
  ])('masks %s', (_format, input, secret) => {
    const { text, masked } = maskSecrets(input);
    expect(masked).toBe(1);
    expect(text).not.toContain(secret);
  });

  it('masks only the value: the name, a comment and the other lines stay', () => {
    const yaml = [
      'db:',
      '  user: app',
      '  password: Pr0dDbPassw0rd2026  # rotated monthly',
      '  host: db.internal',
    ];
    expect(maskSecrets(yaml.join('\n')).text).toBe(
      ['db:', '  user: app', '  password: ••••••••  # rotated monthly', '  host: db.internal'].join('\n'),
    );
    expect(maskSecrets('password = Pr0dDbPassw0rd2026\r\nuser = app\r\n').text).toBe(
      'password = ••••••••\r\nuser = app\r\n',
    );
  });

  it('keeps public kubeconfig data and setting names', () => {
    const kubeconfig = [
      `    certificate-authority-data: ${keyData}`,
      '    server: https://cluster.example.com',
      '  name: prod',
    ].join('\n');
    expect(maskSecrets(kubeconfig).masked).toBe(0);
  });

  it.each([
    '  password: hashedPassword,',
    '  password: hashedPassword',
    '  password = hashed_password',
    '  password: undefined,',
    '  password: SecretStr',
    '  apiKey: config.apiKey,',
    '  Password: cfg.Password,',
    '  password: params[:password],',
    '  password: Joi.string().min(8).required(),',
    '    this.credentials = credentials;',
    '  credentials: MemoizedProvider<AwsCredentialIdentity>;',
    '  api_key: Option<String>,',
    '  MERGESTORY_S3_SECRET_ACCESS_KEY: SECRET_KEY,',
    '    this._passThroughOptions = !!passThrough;',
    '  secret: process.env.JWT_SECRET!,',
    '  password: ${{ secrets.DB_PASSWORD }}',
    '  password: {{ .Values.db.password }}',
    'spring.datasource.password=${DB_PASSWORD}',
    '      secretName: db-credentials',
    '  password_file: /run/secrets/db-password',
    '  token_endpoint: https://oauth2.googleapis.com/token',
    '  - key: app',
    '  cache-key: node-modules-v2',
    '  keyPrefix: mergestory-cache-v2025',
    'Password: the new check rejects short ones',
  ])('leaves ordinary code and settings alone: %s', (input) => {
    expect(maskSecrets(input)).toEqual({ text: input, masked: 0 });
  });
});

describe('isSensitivePath', () => {
  it('hides credential files but not templates', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('config/.env.production')).toBe(true);
    expect(isSensitivePath('deploy/id_ed25519')).toBe(true);
    expect(isSensitivePath('infra/prod.tfstate')).toBe(true);
    expect(isSensitivePath('.env.example')).toBe(false);
    expect(isSensitivePath('src/auth/token.ts')).toBe(false);
  });

  it.each([
    '.kube/config',
    'deploy/.kube/config',
    'kubeconfig',
    'kubeconfig.yaml',
    'clusters/kubeconfig-prod.yml',
    'clusters/staging.kubeconfig',
    '.pgpass',
    '.my.cnf',
    '.s3cfg',
    '.git-credentials',
    '.vault-token',
    '.dockercfg',
    'keys/AuthKey_ABC123.p8',
    '.cargo/credentials.toml',
    '.terraform.d/credentials.tfrc.json',
    '.config/gh/hosts.yml',
    'infra/terraform.tfvars.json',
    'infra/prod.auto.tfvars.json',
  ])('hides %s', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each(['pkg/kubeconfig.go', 'pkg/kubeconfig_test.go', 'docs/kubeconfig.md', 'src/credentials.ts'])(
    'shows the code file %s',
    (path) => {
      expect(isSensitivePath(path)).toBe(false);
    },
  );
});

describe('maskEmails', () => {
  it('keeps the domain and hides the person', () => {
    expect(maskEmails('Contact jane.doe@example.com today')).toBe('Contact j•••@example.com today');
  });
});

describe('maskPrivate', () => {
  const sample =
    'mail ann@example.com, token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password = "hunter2hunter2"';
  const byHand = (text: string, emails: boolean): string => {
    const masked = maskSecrets(text).text;
    return emails ? maskEmails(masked) : masked;
  };

  it('masks secrets then e-mail addresses, exactly as the two calls by hand', () => {
    expect(maskPrivate(sample, { maskEmails: true })).toBe(byHand(sample, true));
    expect(maskPrivate(sample, { maskEmails: true })).not.toContain('ann@');
  });

  it('keeps e-mail addresses when the setting is off, and still masks secrets', () => {
    const out = maskPrivate(sample, { maskEmails: false });
    expect(out).toBe(byHand(sample, false));
    expect(out).toContain('ann@example.com');
    expect(out).not.toContain('ghp_');
  });

  it('reports what each step changed', () => {
    const report = maskPrivateReport(sample, { maskEmails: true });
    expect(report.text).toBe(byHand(sample, true));
    expect(report.secrets).toBeGreaterThan(0);
    expect(report.secretsChanged).toBe(true);
    expect(report.emailsChanged).toBe(true);
    const clean = maskPrivateReport('nothing here', { maskEmails: true });
    expect(clean).toEqual({ text: 'nothing here', secrets: 0, secretsChanged: false, emailsChanged: false });
    expect(maskPrivateReport(sample, { maskEmails: false }).emailsChanged).toBe(false);
  });

  it('does not count already masked text as a change', () => {
    const once = maskPrivate('password = "hunter2hunter2"', { maskEmails: false });
    expect(maskPrivateReport(once, { maskEmails: false }).secretsChanged).toBe(false);
  });
});
