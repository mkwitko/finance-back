# DEPLOYMENT.md — Deploy AWS-nativo com Pipeline Automatizado

> GitHub (CodeConnections) → CodePipeline → CodeBuild → ECR → CodeDeploy (rolling, half-at-a-time) → EC2. Staging automático, produção com aprovação manual. Rollback automático em falha ou alarme. Toda infra como código (AWS CDK).

---

## 1. Visão geral do fluxo

```
[Você commita em CodeCommit branch develop]
            ↓
[CodePipeline detecta push]
            ↓
[Stage: Source] copia código
            ↓
[Stage: Build] CodeBuild roda:
   - pnpm install
   - pnpm typecheck
   - pnpm test:run
   - pnpm test:integration
   - docker build → push pra ECR (tag: commit-sha + 'staging')
   - drizzle migrations geradas validadas
            ↓
[Stage: Deploy-Migrations-Staging]
   - Roda `node dist/scripts/migrate.js` contra RDS staging
            ↓
[Stage: Deploy-Staging]
   - CodeDeploy: blue/green na ASG de staging
   - ALB troca tráfego
   - Smoke test (curl /health/ready + endpoints críticos)
            ↓
[Stage: Manual-Approval]  ← você aprova no console AWS
            ↓
[Stage: Deploy-Migrations-Prod]
            ↓
[Stage: Deploy-Prod]
   - CodeDeploy blue/green em produção
   - Rollback automático se CloudWatch alarms dispararem
```

---

## 2. Conceitos para quem é novo nisso

### 2.1 ECR (Elastic Container Registry)

É a "biblioteca de imagens Docker" da AWS. Quando o CodeBuild termina `docker build`, ele faz `docker push` pra ECR. Cada imagem ganha uma `tag` (geralmente o commit SHA). A EC2 depois faz `docker pull` da ECR pra rodar.

**Por que precisa:** sem registry, cada EC2 teria que ter o código-fonte e fazer `docker build` local. Mais lento, mais variabilidade, problemas de credenciais.

### 2.2 CodeBuild

Servidor de build temporário que executa `buildspec.yml`. Roda em container Linux, com acesso a Docker, Node, pnpm. O resultado fica no S3 (artifacts) ou ECR (imagem).

### 2.3 CodeDeploy + Blue/Green

CodeDeploy é o orquestrador do rollout. **Blue/Green** significa:
- **Verde** = versão atual em produção (ASG verde com 3 instâncias)
- **Azul** = versão nova (CodeDeploy sobe ASG azul com mais 3 instâncias)
- Quando azul passa healthcheck do ALB, CodeDeploy troca o target group
- Tráfego vai 100% pro azul
- Verde fica parado por X minutos (config) caso precise rollback rápido
- Depois, verde é terminado

**Zero downtime**: tráfego sempre vai pra instâncias saudáveis.

**Rollback automático**: se durante a janela de validação algum alarme CloudWatch dispara (5xx, latência, erros), CodeDeploy reverte sozinho.

### 2.4 AWS CDK

Infraestrutura como código. Em vez de clicar no console AWS pra criar ALB/ASG/Pipeline (e perder o registro), você escreve TypeScript e o CDK gera o CloudFormation. Reproduzível, versionado no git.

---

## 3. Estrutura de infra/ (CDK)

```
infra/
├── bin/
│   └── app.ts                  # entrypoint: instancia stacks
├── lib/
│   ├── network-stack.ts        # VPC, subnets públicas/privadas, NAT, SGs
│   ├── data-stack.ts           # RDS Postgres, ElastiCache (se precisar)
│   ├── compute-stack.ts        # ALB + ASG + Launch Template + CodeDeploy app
│   ├── pipeline-stack.ts       # CodeCommit ref + CodePipeline + CodeBuild + ECR
│   └── observability-stack.ts  # CloudWatch dashboards + alarms + SNS
├── cdk.json
├── package.json
└── tsconfig.json
```

---

## 4. `buildspec.yml` (CodeBuild)

```yaml
# buildspec.yml
version: 0.2

env:
  variables:
    NODE_VERSION: "22"
  parameter-store:
    # Secrets vêm do SSM Parameter Store
    DATABASE_URL_STAGING: "/myapp/staging/DATABASE_URL"

phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - corepack enable
      - corepack prepare pnpm@9 --activate
      - pnpm install --frozen-lockfile

  pre_build:
    commands:
      - echo "Logging in to ECR..."
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
      - REPO_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/myapp-api
      - IMAGE_TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:7}
      - echo "Building tag $IMAGE_TAG"

  build:
    commands:
      - echo "Linting and type checking..."
      - pnpm check
      - pnpm typecheck

      - echo "Running unit tests..."
      - pnpm test:run

      - echo "Running integration tests..."
      - pnpm test:integration

      - echo "Building Docker image..."
      - docker build -t $REPO_URI:$IMAGE_TAG -f docker/Dockerfile .
      - docker tag $REPO_URI:$IMAGE_TAG $REPO_URI:latest

  post_build:
    commands:
      - echo "Pushing to ECR..."
      - docker push $REPO_URI:$IMAGE_TAG
      - docker push $REPO_URI:latest

      - echo "Generating appspec and taskdef artifacts..."
      - sed "s|<IMAGE_URI>|$REPO_URI:$IMAGE_TAG|g" appspec.template.yml > appspec.yml
      - echo "{\"ImageURI\":\"$REPO_URI:$IMAGE_TAG\"}" > imageDetail.json

artifacts:
  files:
    - appspec.yml
    - imageDetail.json
    - scripts/migrate.js  # opcional: separar migrations
  discard-paths: yes

cache:
  paths:
    - "/root/.local/share/pnpm/store/**/*"
    - "node_modules/**/*"
```

---

## 5. `appspec.yml` (CodeDeploy)

Para deploy em **EC2 com Docker** (CodeDeploy puxa imagem da ECR e roda):

```yaml
# appspec.template.yml — `<IMAGE_URI>` substituído pelo CodeBuild
version: 0.0
os: linux

files:
  - source: /
    destination: /opt/myapp

hooks:
  # Antes de instalar: para versão anterior
  ApplicationStop:
    - location: scripts/deploy/stop.sh
      timeout: 60
      runas: ec2-user

  # Após copiar files: prepara ambiente (pull imagem ECR)
  BeforeInstall:
    - location: scripts/deploy/before-install.sh
      timeout: 300
      runas: ec2-user

  # Inicia container
  ApplicationStart:
    - location: scripts/deploy/start.sh
      timeout: 120
      runas: ec2-user

  # CodeDeploy só marca sucesso depois desse hook passar
  ValidateService:
    - location: scripts/deploy/validate.sh
      timeout: 120
      runas: ec2-user
```

### 5.1 Scripts do CodeDeploy

```bash
#!/bin/bash
# scripts/deploy/before-install.sh
set -euo pipefail

REPO_URI=$(cat /opt/myapp/imageDetail.json | jq -r .ImageURI)
echo "Pulling $REPO_URI..."

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${REPO_URI%%/*}"

docker pull "$REPO_URI"
echo "$REPO_URI" > /opt/myapp/current-image
```

```bash
#!/bin/bash
# scripts/deploy/start.sh
set -euo pipefail

IMAGE=$(cat /opt/myapp/current-image)

# Carrega envs do SSM Parameter Store
ENV_FILE=/opt/myapp/api.env
aws ssm get-parameters-by-path \
  --path "/myapp/${ENVIRONMENT}/" \
  --with-decryption \
  --query "Parameters[*].[Name,Value]" \
  --output text | \
  awk -F'\t' '{ gsub(".*/", "", $1); print $1"="$2 }' > "$ENV_FILE"

# Para container anterior (se ainda rodando)
docker stop myapp-api 2>/dev/null || true
docker rm myapp-api 2>/dev/null || true

# Roda novo
docker run -d \
  --name myapp-api \
  --restart unless-stopped \
  --network host \
  --env-file "$ENV_FILE" \
  --log-driver=awslogs \
  --log-opt awslogs-region="$AWS_REGION" \
  --log-opt awslogs-group="/myapp/${ENVIRONMENT}/api" \
  --log-opt awslogs-stream="$(hostname)/$(date +%Y%m%d%H%M%S)" \
  "$IMAGE"
```

```bash
#!/bin/bash
# scripts/deploy/validate.sh
set -euo pipefail

# Espera até 60s pela aplicação responder healthy
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health/ready > /dev/null; then
    echo "Service ready after ${i}*2s"
    exit 0
  fi
  sleep 2
done

echo "Service failed to become ready"
exit 1
```

```bash
#!/bin/bash
# scripts/deploy/stop.sh
set -euo pipefail
docker stop myapp-api 2>/dev/null || true
docker rm myapp-api 2>/dev/null || true
```

---

## 6. Pipeline CDK (`infra/lib/pipeline-stack.ts`)

Resumo conceitual (não vou colar 500 linhas; veja [aws-cdk-lib documentação](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-construct-library.html) pra detalhes):

```ts
// infra/lib/pipeline-stack.ts (esqueleto)
import { Stack, type StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Repository as EcrRepository } from "aws-cdk-lib/aws-ecr";
import { Repository as CodeCommitRepository } from "aws-cdk-lib/aws-codecommit";
import { Pipeline, Artifact } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeCommitSourceAction,
  CodeBuildAction,
  ManualApprovalAction,
  CodeDeployServerDeployAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { PipelineProject, LinuxBuildImage, BuildSpec, ComputeType } from "aws-cdk-lib/aws-codebuild";
import { ServerApplication, ServerDeploymentGroup, ServerDeploymentConfig } from "aws-cdk-lib/aws-codedeploy";
import type { Construct } from "constructs";

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // ECR repo
    const ecrRepo = new EcrRepository(this, "EcrRepo", {
      repositoryName: "myapp-api",
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 30 }],
    });

    // CodeCommit (referência ao repo existente)
    const repo = CodeCommitRepository.fromRepositoryName(this, "Repo", props.repoName);

    // CodeBuild project
    const buildProject = new PipelineProject(this, "Build", {
      buildSpec: BuildSpec.fromSourceFilename("buildspec.yml"),
      environment: {
        buildImage: LinuxBuildImage.STANDARD_7_0,
        computeType: ComputeType.MEDIUM,
        privileged: true, // pra rodar docker
        environmentVariables: {
          AWS_ACCOUNT_ID: { value: this.account },
          AWS_DEFAULT_REGION: { value: this.region },
        },
      },
    });
    ecrRepo.grantPullPush(buildProject);

    // CodeDeploy applications (uma por ambiente)
    const stagingDeployApp = new ServerApplication(this, "StagingDeployApp", {
      applicationName: "myapp-api-staging",
    });
    const stagingDeployGroup = new ServerDeploymentGroup(this, "StagingDeployGroup", {
      application: stagingDeployApp,
      autoScalingGroups: [props.stagingAsg],
      loadBalancer: /* ALB referência */,
      deploymentConfig: ServerDeploymentConfig.ALL_AT_ONCE, // ou CUSTOM com blue/green
      // Para EC2 + Docker, usamos blue/green via duas ASGs + ALB swap.
      // Para simplicidade: começamos com in-place deploy + healthcheck rigoroso.
    });

    const prodDeployApp = new ServerApplication(this, "ProdDeployApp", {
      applicationName: "myapp-api-prod",
    });
    // ... similar para produção

    // Pipeline
    const sourceOutput = new Artifact("Source");
    const buildOutput = new Artifact("Build");

    const pipeline = new Pipeline(this, "Pipeline", {
      pipelineName: "myapp-api-pipeline",
      restartExecutionOnUpdate: true,
      stages: [
        {
          stageName: "Source",
          actions: [
            new CodeCommitSourceAction({
              actionName: "Source",
              repository: repo,
              branch: "develop",
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: "Build",
          actions: [
            new CodeBuildAction({
              actionName: "Build",
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
        {
          stageName: "DeployStaging",
          actions: [
            new CodeDeployServerDeployAction({
              actionName: "Deploy",
              deploymentGroup: stagingDeployGroup,
              input: buildOutput,
            }),
          ],
        },
        {
          stageName: "ApproveProd",
          actions: [
            new ManualApprovalAction({
              actionName: "Approve",
              additionalInformation: "Aprovar deploy para produção?",
            }),
          ],
        },
        {
          stageName: "DeployProd",
          actions: [
            new CodeDeployServerDeployAction({
              actionName: "Deploy",
              deploymentGroup: prodDeployGroup,
              input: buildOutput,
            }),
          ],
        },
      ],
    });
  }
}
```

> **Observação importante sobre blue/green em EC2 puro:** o CodeDeploy oferece blue/green nativo para ECS e Lambda. Para EC2, há duas opções:
> 1. **In-place deploy** com health checks rigorosos (mais simples; downtime de ~3-5s por instância, mitigado pela rotação no ALB).
> 2. **Blue/green real** via duas ASGs + ALB target group swap (mais complexo; zero downtime de verdade).
>
> Comece com (1) se simplicidade conta. Migre para (2) quando o SLA exigir.

---

## 7. Rollback automático

CloudWatch alarms ligados ao deployment group disparam rollback. Em `observability-stack.ts`:

```ts
import { Alarm, ComparisonOperator } from "aws-cdk-lib/aws-cloudwatch";

const errorRateAlarm = new Alarm(this, "ErrorRate", {
  metric: alb.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT),
  threshold: 10,
  evaluationPeriods: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
});

const latencyAlarm = new Alarm(this, "Latency", {
  metric: alb.metrics.targetResponseTime(),
  threshold: 1, // 1s
  evaluationPeriods: 3,
});

deploymentGroup.addAlarm(errorRateAlarm);
deploymentGroup.addAlarm(latencyAlarm);
// Se qualquer alarme disparar durante a janela de validação → rollback
```

Configuração do deployment group:

```ts
new ServerDeploymentGroup(this, "ProdDeployGroup", {
  // ...
  autoRollback: {
    failedDeployment: true,    // rollback se deploy falha
    stoppedDeployment: true,
    deploymentInAlarm: true,   // rollback se alarme dispara
  },
});
```

---

## 8. Aprovação manual entre staging e prod

`ManualApprovalAction` (visto acima). Quando o pipeline chega nesse stage, ele para e envia notificação SNS pra quem você configurar. Você abre o console AWS, vê o link de staging, testa, e clica "Approve" ou "Reject".

Pode integrar com Slack via SNS → Lambda → Slack webhook.

---

## 9. Disparando deploy

### 9.1 Para staging — automático

```bash
git push origin develop
# Pipeline detecta, executa stages 1-3, deploya em staging automaticamente
```

### 9.2 Para produção — workflow GitOps

Hoje a empresa usa CodeCommit. Workflow recomendado:

1. Branch `develop` ↔ ambiente staging (push automático).
2. Branch `main` ↔ ambiente produção.
3. Para subir prod: merge `develop` → `main` via PR + aprovação no console AWS no estágio `ApproveProd`.

Ou em um único pipeline com aprovação manual entre stages (como modelado acima). Escolha conforme cultura do time.

### 9.3 Comandos pnpm de conveniência

```json
{
  "scripts": {
    "deploy:staging": "git push origin develop",
    "deploy:prod": "echo 'Crie um PR develop → main no console AWS, ou aprove o stage ApproveProd'",
    "infra:diff": "cd infra && pnpm cdk diff",
    "infra:deploy": "cd infra && pnpm cdk deploy --all",
    "infra:synth": "cd infra && pnpm cdk synth"
  }
}
```

> **Nota:** "deploy" como comando local raramente acontece em pipelines AWS-nativos. O pipeline reage a commits. `pnpm deploy:staging` é só um alias amigável pra `git push`.

---

## 10. Variáveis de ambiente em produção

### 10.1 Onde ficam

**SSM Parameter Store** (não-segredos) e **Secrets Manager** (segredos).

Organização:

```
/myapp/staging/DATABASE_URL              (SecureString)
/myapp/staging/COGNITO_USER_POOL_ID
/myapp/staging/COGNITO_CLIENT_ID
/myapp/staging/S3_BUCKET_UPLOADS
/myapp/staging/SQS_BOOKING_CREATED_URL
/myapp/staging/SNS_BOOKING_EVENTS_TOPIC_ARN
/myapp/staging/B2B_USERS_BASE_URL
...

/myapp/prod/DATABASE_URL
/myapp/prod/...
```

### 10.2 Como o app pega

O script `start.sh` (CodeDeploy) lê todos os parâmetros sob `/myapp/$ENVIRONMENT/` e escreve num arquivo `.env`, que é passado ao container via `--env-file`.

Permissão: EC2 IAM role tem `ssm:GetParametersByPath` apenas no path do seu ambiente.

---

## 11. Migrations no pipeline

Migrations rodam **antes** do deploy do app, num step separado:

```yaml
# stage Build (continuação)
post_build:
  commands:
    # ... build do app ...
    - echo "Running migrations against staging DB..."
    - pnpm db:migrate
```

> Cuidado: o CodeBuild precisa de acesso de rede ao RDS staging (VPC endpoint ou private subnet) e permissão IAM pra ler o `DATABASE_URL` do Parameter Store.

Para produção, migrations rodam **dentro do stage de aprovação manual** ou num stage dedicado **antes** do `DeployProd`. Convenção: aplicação só é compatível "com migration N e N-1" (estratégia 2-deploy para mudanças destrutivas). Veja [`OPERATIONS.md`](./OPERATIONS.md#migrations-em-produção).

---

## 12. Logs do deploy

Onde olhar quando algo dá errado:

- **CodePipeline** → console mostra qual stage falhou.
- **CodeBuild** → logs no CloudWatch `/aws/codebuild/myapp-api-build`.
- **CodeDeploy** → logs no CloudWatch `/aws/codedeploy-agent/...` na EC2.
- **Script de hook (start.sh, etc)** → `/opt/codedeploy-agent/deployment-root/.../logs/scripts.log` na EC2.

---

## 13. Bootstrap inicial (uma vez por conta AWS)

```bash
# Instala CDK CLI
pnpm add -g aws-cdk

# Bootstrap (cria S3 bucket, roles que o CDK precisa)
cd infra
pnpm cdk bootstrap aws://ACCOUNT_ID/REGION

# Primeira deploy: provisiona tudo
pnpm cdk deploy --all
```

Daqui pra frente, mudanças na infra:

```bash
pnpm infra:diff      # mostra o que vai mudar
pnpm infra:deploy    # aplica
```

---

## 14. Checklist de deploy

Antes do primeiro deploy real:

- [ ] CodeCommit repo criado e com `develop` + `main` branches
- [ ] CDK bootstrap rodado na conta AWS
- [ ] `pnpm infra:deploy` executou sem erros
- [ ] Variáveis em SSM Parameter Store preenchidas para `/myapp/staging/*` e `/myapp/prod/*`
- [ ] RDS staging acessível pela security group das EC2 e do CodeBuild
- [ ] ECR repo `myapp-api` existe
- [ ] ALB com target group apontando pra ASG, healthcheck `/health/ready`
- [ ] CloudWatch alarms (5xx, latência) ligados ao CodeDeploy
- [ ] SNS topic pra notificação de aprovação manual + alarmes
- [ ] Cognito User Pool criado (separado staging/prod) e IDs no Parameter Store

Antes de cada deploy de prod:

- [ ] Staging testado manualmente
- [ ] Migrations revisadas (SQL inspecionado no PR)
- [ ] Smoke test passa em staging
- [ ] Rollback plan claro (feature flag? migration backward-compatible?)
