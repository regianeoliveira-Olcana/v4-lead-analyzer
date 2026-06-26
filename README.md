// ==UserScript==
// @name         🔴 V4 Lead Analyzer LDR
// @namespace    https://v4company.com
// @version      6.4
// @description  Híbrido: Gemini busca + OpenAI análise + OutboundPro + Brasil API · status integrações + janela 10s + anti-sobreposição
// @author       V4 Company
// @match        https://brokers.mktlab.app/*
// @updateURL    https://raw.githubusercontent.com/regianeoliveira-Olcana/v4-lead-analyzer/main/v4-lead-analyzer.user.js
// @downloadURL  https://raw.githubusercontent.com/regianeoliveira-Olcana/v4-lead-analyzer/main/v4-lead-analyzer.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @connect      api.openai.com
// @connect      generativelanguage.googleapis.com
// @connect      brasilapi.com.br
// @connect      app.outboundpro.com.br
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // PROMPT DE ANÁLISE FINAL
  // ═══════════════════════════════════════════════════════════════
  const ANALYSIS_PROMPT = `Você é um auditor de leads B2B da V4 Company.
Decisão de compra de lead em leilão. Zero alucinação.
Use APENAS os dados fornecidos (LeadBroker + OutboundPro + Brasil API).

PAPEL DO LDR (este botão):
Decidir se vale o lance no leilão.
NÃO recomendar produto — isso é trabalho do Closer.
NÃO qualificar dor profunda — isso é trabalho do SDR.
Foco: empresa real? decisor confirmado? capacidade financeira plausível?

═══════════════════════════════════════════════════
GATES (DOIS — TUDO OU NADA)
═══════════════════════════════════════════════════
GATE 1 — Empresa REAL (ATIVA):
  ✅ CNPJ encontrado e situação ATIVA
  ⚠️ Sem CNPJ MAS com rastro digital forte
     (Instagram + endereço + telefone)
     → Gate 1 PROVÁVEL, teto 65/100
  ❌ Sem CNPJ E sem rastro digital → VETO

GATE 2 — Decisor com PROVA EXTERNA PÚBLICA (cruzamento múltiplo)

REGRA UNIFICADA para TODOS os tiers:
"Gerente Geral" em QUALQUER tier = DECISOR.
Em empresas pequenas, ele toma decisões.
Em franquias, ele opera o negócio.
Em corporações, ele gerencia P&L da unidade.

✅ CONFIRMADO — exige CRUZAMENTO MÚLTIPLO:
Pelo menos UMA destas opções:
   A) Nome no QSA (Brasil API ou OutboundPro)
   B) LinkedIn com cargo de alçada + empresa
      bate com lead + sobrenome único OU
      outra evidência cruzada

Cargos de alçada aceitos (qualquer tier):
   • Sócio / Dono / Proprietário / Founder
   • C-Level (CEO, CMO, CFO, COO, CTO)
   • Diretor (qualquer área decisória)
   • VP / Head
   • GERENTE GERAL ← decisor real
   • GERENTE DE UNIDADE / FRANQUIA
   • Gerente Marketing / Vendas / Comercial / RevOps

⚠️ POSSÍVEL MATCH — pista isolada (não basta):
   • LinkedIn encontrado mas empresa não bate 100%
   • Sobrenome comum sem confirmação extra
   • Match parcial só de primeiro nome no QSA
   • Cargo aceitável mas sem confirmação cruzada
   → teto 65/100 → 🟡 RISCO máximo
   → SDR confirma diretamente na ligação

❌ NÃO VALIDADO — sem nenhuma evidência cruzada:
   • Cargo declarado no formulário SÓ (não conta)
   • Nenhum match no QSA + nenhum LinkedIn
   • Investigação web não retornou nada
   → score máx 40/100 → 🔴

═══════════════════════════════════════════════════
⚠️ ARMADILHAS DE CETICISMO — NÃO CAIA NELAS
═══════════════════════════════════════════════════

1. CARGO declarado no formulário (qualquer cargo)
   NÃO É PROVA. Pode ser mentira, engano ou spam.
   Sempre exige confirmação externa.

2. LINKEDIN parecido = pode ser homônimo.
   Cruze: sobrenome único + empresa específica
   + cidade + datas se possível.

3. EMPRESA "encontrada" pode ser homônima.
   Cruze: cidade + porte + CNAE + endereço.
   "Quality Serviços" tem 50 empresas com esse nome.

4. SÓCIO na Receita pode ter SAÍDO.
   Olhe data de entrada se disponível.

5. EMAIL corporativo ≠ pessoa autêntica.
   Pode ser funcionário, estagiário, ex-funcionário.

6. FATURAMENTO declarado pode ser:
   - Inflado (querer parecer maior)
   - Confuso (mensal vs anual)
   - Aspiracional ("quero faturar isso")
   Sempre verifique consistência com porte ME/EPP.

7. "IMEDIATAMENTE" como urgência pode ser default
   do formulário, não escolha real.

8. GERENTE GERAL em LinkedIn precisa ter:
   - Empresa específica (não genérica)
   - Cargo ATUAL (não trabalho antigo)
   - Sobrenome único OU cruzamento extra

REGRA DE OURO:
- 1 evidência isolada → ⚠️ POSSÍVEL MATCH
- 2 evidências independentes que se confirmam → ✅ CONFIRMADO
- 0 evidências → ❌ NÃO VALIDADO

NUNCA aceite "cargo declarado" como evidência.

═══════════════════════════════════════════════════
TIERS (tabela oficial V4 — mensal)
═══════════════════════════════════════════════════
TINY:        até R$ 100k/mês      (anual até R$ 1,2M)
SMALL:       R$ 100k – 399k/mês   (anual R$ 1,2M – 4,7M)
MEDIUM:      R$ 400k – 999k/mês   (anual R$ 4,8M – 11M)
MEDIUM-PLUS: R$ 1M – 4M/mês       (anual R$ 12M – 49M)
LARGE:       R$ 4,1M – 16M/mês    (anual R$ 50M – 199M)
LARGE-PLUS:  R$ 16,1M – 40M/mês   (anual R$ 200M – 480M)
ENTERPRISE:  R$ 40M+/mês          (anual R$ 481M+)

AUTORIDADE POR TIER — quem pode preencher o form:
TINY/SMALL/MEDIUM (até R$1M/mês):
  SÓ aceita Sócio/Dono/Proprietário/Diretor confirmado no QSA.
  Sem isso → 🔴 obrigatório (Gate 2 rígido).

MEDIUM-PLUS / LARGE / LARGE-PLUS / ENTERPRISE (R$1M+/mês):
  Aceita também executivo de alçada via LinkedIn:
  Diretor / VP / Head / C-Level / Gerente Sênior
  de Marketing / Vendas / Comercial / RevOps.
  Executivo NOVO no cargo = sinal QUENTE.

═══════════════════════════════════════════════════
ESTRATÉGIA INVESTIGATIVA POR TIER
═══════════════════════════════════════════════════

TINY (até R$100k/mês declarado) — CAÇA POR ACHADOS
  🎯 PRIORIDADE INVESTIGATIVA: NUNCA descarte um TINY
     sem antes verificar se é FALSO TINY (achado).

  Sinais de FALSO TINY (achado = empresário maior
  declarando faturamento baixo no formulário):
  ✅ Capital Social ≥ R$100k
  ✅ Empresa ≥ 5 anos operando
  ✅ Endereço em polo comercial/industrial reconhecido
  ✅ Setor de alta margem com faturamento declarado baixo
     (médico, SaaS, consultoria, infoproduto declarando R$80k?)
  ✅ Sócio em OUTRAS empresas ativas (related_companies)
  ✅ Faturamento declarado pode ser confusão MENSAL × ANUAL
     (R$80k ANUAL talvez seja R$80k MENSAL de verdade)
  ✅ Setor inconsistente com porte/capital
  ✅ Nome fantasia robusto + endereço em centro empresarial

  REGRA DE DECISÃO:
  • 3+ sinais → ACHADO confirmado → boost de score
    → reanalisa CAPACIDADE como se fosse SMALL/MEDIUM
    → flag no output: "💎 ACHADO — falso tiny provável"
    → 🟡 RISCO ou 🟢 dependendo dos outros gates
  • 1-2 sinais → ACHADO POSSÍVEL → flag para SDR
    confirmar faturamento real na ligação
    → 🟡 RISCO (não veta automaticamente)
  • 0 sinais + Gate 2 ❌ → TINY genuíno → 🔴
  • 0 sinais + Gate 2 ✅ → TINY genuíno mas decisor
    real → 🟡 (lance baixo pode valer)

  📌 IMPORTANTE: o falso tiny é A OPORTUNIDADE
  do leilão TINY. NÃO descarte sem investigar
  capital social, idade da empresa, related_companies.

SMALL (R$100k–399k/mês declarado) — onde está o VOLUME
  Tier mais comum e valioso pelo volume.
  Empresa faturando R$1,2–4,7M/ano com decisor real
  é alvo legítimo do funil V4.
  Margem do setor INFORMA, NÃO EXCLUI:
  → setor de margem baixa com fat. neste range
    ainda pode ser ICP (depende do líquido real)
  Foco: confirmar autoridade do decisor + WTP

MEDIUM e acima (R$400k+/mês) — o JOGO BOM
  Escassos, mas alto valor.
  Quando aparecer com gates passando → 🟢 sem hesitar.
  Closer decide o produto depois.

═══════════════════════════════════════════════════
🚨 AMBIGUIDADE MENSAL × ANUAL (regra central)
═══════════════════════════════════════════════════

Empresários frequentemente CONFUNDEM ao declarar.
Padrão do LeadBroker = mensal, mas muitos digitam
o valor ANUAL achando que é mensal.

SINAIS DE AMBIGUIDADE (declaração suspeita):
⚠️ Porte na Receita = ME (teto R$360k/ANO)
   mas declarou R$200k/MÊS = R$2,4M/ano
   → declaração mensal IMPOSSÍVEL p/ ME
   → provavelmente R$200k ANUAL (~R$17k/mês)
   → reclassifica como TINY real

⚠️ Capital Social muito baixo (< R$10k) +
   faturamento declarado alto (R$200k+/mês)
   → suspeita

⚠️ Empresa com < 1 ano + faturamento alto
   → suspeita (a não ser que seja franquia ou
     spin-off comprovado)

⚠️ Setor pequeno (varejo local, food bairro)
   + faturamento de SMALL/MEDIUM declarado
   → confirmar com presença digital + porte

QUANDO HOUVER AMBIGUIDADE:
1. Calcular ICP nos DOIS cenários (mensal e anual)
2. Informar AMBOS no output
3. Flag obrigatória: "SDR confirma na ligação se
   o valor declarado é mensal ou anual"
4. NÃO descartar — pode ser oportunidade legítima
   se for mensal real, ou TINY real se for anual

═══════════════════════════════════════════════════
MARGEM POR SETOR (referência)
═══════════════════════════════════════════════════
Medicina especializada:           50%
Serviços B2B/Consultoria/Clínica: 35%
Franquia Serviços (educ/saúde):   35-45%
Indústria D2C:                    25-35%
Indústria B2B direto:             20-30%
Construção/Engenharia:            20%
Imobiliária:                      15%
Infoproduto/SaaS/Digital:         80%
Franquia Tech/Financeira:         50%
Varejo/Franquia Varejo:           15%
Indústria atacado/canal:          7%

⚠️ A margem INFORMA, NÃO EXCLUI:
Setor de baixa margem + faturamento bom (SMALL+)
ainda é ICP legítimo. O importante é a CAPACIDADE
de gerar fluxo de caixa.

═══════════════════════════════════════════════════
SCORING (0-100) — só se Gates passarem
═══════════════════════════════════════════════════

ICP FINANCEIRO — 40 pts (capacidade financeira por tier)
40: MEDIUM+ (R$400k+/mês) — alta capacidade de investimento
40: TINY com 3+ sinais de ACHADO (💎 falso tiny confirmado)
    → trate como SMALL/MEDIUM com base nos sinais
30: SMALL (R$100k–399k/mês) — boa capacidade, foco do volume V4
20: TINY com 1-2 sinais de achado (achado possível, SDR confirma)
10: TINY genuíno com margem alta + Capital Social >R$50k
0:  TINY genuíno sem qualquer indicador de capacidade
0:  Ambiguidade não resolvida (mensal vs anual)
   → flag SDR confirma, mas score zero por padrão

⚠️ NÃO recomende produto. Apenas avalie capacidade.
Closer decide o produto após o diagnóstico do SDR.

CANAL + URGÊNCIA — 30 pts
30: Google + urgência imediata
22: Google sem urgência
18: Institucional + urgência
14: Institucional sem urgência
10: Instagram + urgência
6:  Instagram sem urgência
3:  Facebook ou TikTok
0:  Desconhecido

MATERIALIDADE — 20 pts
20: CNPJ ativo + email corporativo + presença digital
15: CNPJ ativo + email corporativo
10: CNPJ ativo + email gmail/hotmail + empresa real
5:  CNPJ ativo + sem digital mas física comprovada
0:  Dados inconsistentes

CONTEXTO GEOGRÁFICO — 10 pts
10: Zona Verde (Sudeste/Sul/CO/MT/MS)
7:  Zona Amarela + polo confirmado
5:  Zona Amarela sem polo
3:  Zona Vermelha com polo
0:  Zona Vermelha sem polo

VEREDITO:
75-100 → 🟢 ARREMATAR
50-74  → 🟡 RISCO CALCULADO
0-49   → 🔴 NÃO COMPRAR

═══════════════════════════════════════════════════
FORMATO DE SAÍDA (exato)
═══════════════════════════════════════════════════

🔍 [Nome da Empresa] | TIER: [TINY/SMALL/MEDIUM/MEDIUM-PLUS/LARGE/LARGE-PLUS/ENTERPRISE]

VEREDITO: 🟢 ARREMATAR | 🟡 RISCO CALCULADO | 🔴 NÃO COMPRAR
SCORE: [X]/100

GATES:
[✅/❌] CNPJ: [número ou "não validado"] [ATIVO/INATIVO]
[✅/⚠️/❌] Decisor:
   ✅ CONFIRMADO se nome bate exatamente OU é variação óbvia
       (ex: "João Silva" = "João da Silva Santos")
   ⚠️ POSSÍVEL MATCH se nome incompleto/abreviado
       (ex: "J Silva" pode ser "João da Silva" — confirme visualmente)
   ❌ NÃO VALIDADO se nome do contato não bate com NINGUÉM no QSA
   (cargo declarado no form NÃO conta)

EMPRESA
CNPJ: [num] | Capital: R$[X] | Abertura: [ano] ([X] anos)
CNAE: [descrição]
Endereço: [cidade/UF]

🔎 COMPARAÇÃO MANUAL — VOCÊ DECIDE:
Contato declarado no lead: "[nome exato como veio]"

QSA COMPLETO (todos os sócios oficiais):
• [Nome 1] — [Qualificação]
• [Nome 2] — [Qualificação]
• [Nome 3] — [Qualificação]
[Liste TODOS os sócios encontrados, mesmo que nenhum bata]

Match identificado pelo sistema: [nome do match OU "nenhum"]
→ Se ⚠️ POSSÍVEL MATCH: confirme visualmente acima

ICP FINANCEIRO [X]/40
↳ Declarado: R$[X]/mês | Tier: [TINY/SMALL/MEDIUM/...]
↳ Setor: [setor] — margem ~[X]% (referência)
↳ Líquido estimado: R$[X]/mês
↳ [Se TINY: 💎 ACHADO ([X] sinais) OU "tiny genuíno"
    Listar sinais encontrados: capital, idade, polo,
    related_companies, ambiguidade mensal/anual]
↳ [Se ambíguo: cenário mensal R$X | cenário anual R$X]

CANAL + URGÊNCIA [X]/30
↳ [Canal] | Urgência: [imediata/não informada]

MATERIALIDADE [X]/20
↳ Email: [corporativo/gmail]
↳ Presença digital: [LinkedIn/Instagram/iFood encontrados]

GEOGRÁFICO [X]/10
↳ [Zona] | [polo ou não]

DECISOR — DADOS RICOS (apenas se match foi confirmado):
↳ Nome no QSA: [nome completo]
↳ Qualificação: [Sócio-Adm / Sócio / etc]
↳ LinkedIn: [URL ou "não encontrado"]
↳ WhatsApp validado: [número ou "não"]
↳ Email validado: [email ou "não"]
↳ Outras empresas do sócio: [lista ou "verificar"]

FLAGS:
• [bullets críticos]
• [se ⚠️ POSSÍVEL MATCH: "LDR deve confirmar visualmente o sócio antes de comprar"]

CONTEXTO PARA O SDR:
↳ Dor provável: [específica]
↳ Validar na ligação: [crítico]
↳ Dados de contato prontos: [resumo]

═══════════════════════════════════════════════════
REGRAS DE TIER (estritas — tabela oficial V4)
═══════════════════════════════════════════════════
Sempre calcule TIER pelo faturamento MÍNIMO declarado:

• TINY:        até R$ 100k mensais
• SMALL:       R$ 100k – 399k mensais
• MEDIUM:      R$ 400k – 999k mensais
• MEDIUM-PLUS: R$ 1M – 4M mensais
• LARGE:       R$ 4,1M – 16M mensais
• LARGE-PLUS:  R$ 16,1M – 40M mensais
• ENTERPRISE:  acima de R$ 40M mensais

EXEMPLOS de classificação (mínimo declarado):
"De 51 mil à 70 mil"      → TINY (mín 51k)
"De 71 mil à 100 mil"     → TINY (mín 71k)
"De 101 mil à 200 mil"    → SMALL (mín 101k)
"De 201 mil à 400 mil"    → SMALL (mín 201k)
"De 401 mil à 1 milhão"   → MEDIUM (mín 401k)
"De 1 milhão à 5 milhões" → MEDIUM-PLUS (mín 1M)
"De 5 milhões à 10 milhões" → LARGE (mín 4M+)
"Acima de 50 milhões"     → LARGE-PLUS ou ENTERPRISE
NUNCA confunda. O tier é PURO matemática do mínimo declarado.

═══════════════════════════════════════════════════
REGRAS DE MATCH DO DECISOR (estritas)
═══════════════════════════════════════════════════
✅ CONFIRMADO:
   • Nome exato: "João Silva" = "João Silva"
   • Variação óbvia: "Joao da Silva" = "João da Silva Santos"
   • Match com pelo menos 2 nomes (nome + sobrenome) batendo

⚠️ POSSÍVEL MATCH (LDR confirma visualmente):
   • Nome muito curto (1 nome ou inicial): "J Silva", "Maria"
   • Apenas primeiro nome bate
   • Abreviações ambíguas
   → Aplica teto 65/100 → 🟡 RISCO máximo

❌ NÃO VALIDADO:
   • Nenhum sócio do QSA tem qualquer parte do nome
   • Nome do contato é claramente diferente
   → Teto 40/100 → 🔴

SEMPRE liste TODOS os sócios do QSA no output,
mesmo quando o match for ❌. Permite ao LDR
fazer a verificação humana final.`;

  // ═══════════════════════════════════════════════════════════════
  // ESTILOS
  // ═══════════════════════════════════════════════════════════════
  GM_addStyle(`
    #v4-fab {
      position: fixed; bottom: 28px; right: 28px;
      display: flex; align-items: center; gap: 10px;
      background: #CC1414; color: #fff;
      padding: 14px 22px; border-radius: 12px;
      cursor: pointer; font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px; font-weight: 700;
      z-index: 2147483645; border: none;
      box-shadow: 0 4px 24px rgba(204,20,20,0.45);
      transition: all 0.2s ease; user-select: none;
    }
    #v4-fab:hover:not([disabled]) { background: #E02020; transform: translateY(-2px); }
    #v4-fab[disabled] { background: #333; cursor: wait; animation: v4-pulse 1.2s ease-in-out infinite; }
    @keyframes v4-pulse { 50% { opacity: 0.6; } }
    @keyframes v4-spin { to { transform: rotate(360deg); } }

    #v4-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.88); z-index: 2147483646;
      backdrop-filter: blur(8px);
    }
    #v4-overlay.active { display: block; }

    #v4-panel {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      background: #0E0E0E; border: 1px solid #222;
      border-radius: 16px; width: 600px;
      max-width: 94vw; max-height: 90vh;
      overflow: hidden; display: flex; flex-direction: column;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 40px 100px rgba(0,0,0,0.9);
    }

    #v4-header {
      padding: 14px 22px; border-bottom: 1px solid #1E1E1E;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    .v4-brand { display: flex; align-items: center; gap: 10px; }
    .v4-dot { width: 8px; height: 8px; border-radius: 50%; background: #CC1414; box-shadow: 0 0 8px rgba(204,20,20,0.6); }
    .v4-brand-name { font-size: 11px; font-weight: 700; color: #555; letter-spacing: 2.5px; text-transform: uppercase; }
    .v4-cache-badge {
      background: rgba(22,163,74,0.15); color: #16A34A;
      font-size: 9px; font-weight: 700; padding: 3px 8px;
      border-radius: 4px; letter-spacing: 1px;
    }
    #v4-close {
      background: none; border: 1px solid #2A2A2A; color: #666;
      width: 28px; height: 28px; border-radius: 6px;
      cursor: pointer; font-size: 13px;
      display: flex; align-items: center; justify-content: center;
    }
    #v4-close:hover { border-color: #444; color: #999; }

    #v4-mode-bar {
      padding: 10px 22px; border-bottom: 1px solid #1A1A1A;
      display: flex; gap: 6px; align-items: center; background: #0A0A0A;
    }
    .v4-mode-btn {
      flex: 1; padding: 8px; border-radius: 6px;
      border: 1px solid #2A2A2A; background: none;
      color: #555; font-size: 11px; font-weight: 700;
      cursor: pointer; font-family: inherit;
      transition: all 0.15s; letter-spacing: 0.5px;
    }
    .v4-mode-btn.active { background: rgba(204,20,20,0.12); border-color: #CC1414; color: #CC1414; }
    .v4-mode-hint {
      font-size: 10px; color: #555; padding-left: 10px;
      border-left: 1px solid #1E1E1E; line-height: 1.4;
    }

    #v4-body { flex: 1; overflow-y: auto; }
    #v4-body::-webkit-scrollbar { width: 4px; }
    #v4-body::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

    #v4-footer {
      padding: 12px 22px; border-top: 1px solid #1A1A1A;
      display: flex; gap: 8px; flex-shrink: 0;
    }
    .v4-btn-sec {
      flex: 1; padding: 9px; border-radius: 8px;
      border: 1px solid #2A2A2A; background: none;
      color: #666; font-size: 11px; cursor: pointer;
      font-family: inherit; transition: all 0.15s;
    }
    .v4-btn-sec:hover { border-color: #444; color: #999; background: #141414; }

    .v4-instant {
      padding: 22px 24px; border-bottom: 1px solid #1A1A1A;
      background: linear-gradient(180deg, rgba(204,20,20,0.05) 0%, transparent 100%);
    }
    .v4-instant-label {
      font-size: 9px; font-weight: 700; letter-spacing: 2.5px;
      color: #666; text-transform: uppercase; margin-bottom: 10px;
      display: flex; align-items: center; gap: 8px;
    }
    .v4-instant-pulse {
      width: 6px; height: 6px; border-radius: 50%; background: #CC1414;
      animation: v4-pulse 1.5s ease-in-out infinite;
    }
    .v4-instant-text {
      font-size: 26px; font-weight: 800; letter-spacing: -0.5px;
      line-height: 1.1; margin-bottom: 6px;
    }
    .v4-instant-sub { font-size: 12px; color: #999; line-height: 1.5; }

    .v4-valores {
      display: flex; align-items: center; gap: 16px;
      margin-top: 14px; padding: 12px;
      background: rgba(255,255,255,0.04);
      border-radius: 8px;
    }
    .v4-valor-item { flex: 1; text-align: center; }
    .v4-valor-label {
      font-size: 10px; color: #888;
      text-transform: uppercase; letter-spacing: 1px;
      margin-bottom: 4px;
    }
    .v4-valor-num { font-size: 18px; font-weight: 800; color: #FFF; }
    .v4-valor-divider { width: 1px; height: 40px; background: #2A2A2A; }

    .v4-motivos {
      margin-top: 12px; padding: 10px 12px;
      background: rgba(0,0,0,0.2);
      border-left: 2px solid currentColor; border-radius: 4px;
    }
    .v4-motivo { font-size: 12px; color: #BBB; line-height: 1.5; padding: 2px 0; }

    .v4-score-breakdown { margin-top: 12px; padding-top: 10px; border-top: 1px solid #1A1A1A; }
    .v4-score-title { font-size: 11px; color: #888; margin-bottom: 6px; }
    .v4-score-title strong { color: #FFF; font-size: 14px; }
    .v4-score-pills { display: flex; flex-wrap: wrap; gap: 5px; }
    .v4-pill {
      font-size: 10px; padding: 3px 7px;
      background: rgba(255,255,255,0.06);
      border: 1px solid #2A2A2A; border-radius: 4px;
      color: #999; font-family: monospace;
    }
    .v4-instant.verde { border-left: 4px solid #16A34A; }
    .v4-instant.verde .v4-instant-text { color: #16A34A; }
    .v4-instant.amarelo { border-left: 4px solid #D97706; }
    .v4-instant.amarelo .v4-instant-text { color: #D97706; }
    .v4-instant.vermelho { border-left: 4px solid #CC1414; }
    .v4-instant.vermelho .v4-instant-text { color: #CC1414; }

    .v4-extracted { padding: 12px 22px; border-bottom: 1px solid #1A1A1A; background: #0A0A0A; }
    .v4-extracted-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; font-size: 11px; }
    .v4-extracted-item { color: #666; }
    .v4-extracted-item strong { color: #999; font-weight: 600; }

    .v4-progress { padding: 20px 24px; }
    .v4-steps { display: flex; flex-direction: column; gap: 11px; }
    .v4-step { display: flex; align-items: center; gap: 12px; font-size: 12px; color: #555; line-height: 1.4; }
    .v4-step.active { color: #CC1414; }
    .v4-step.done { color: #16A34A; }
    .v4-step.skipped { color: #444; opacity: 0.6; }
    .v4-step-icon {
      width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid #2A2A2A;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; flex-shrink: 0; font-weight: 700;
    }
    .v4-step.active .v4-step-icon {
      border-color: #CC1414; border-top-color: transparent;
      animation: v4-spin 0.8s linear infinite;
    }
    .v4-step.done .v4-step-icon { border-color: #16A34A; background: #16A34A; color: white; }
    .v4-step.skipped .v4-step-icon { border-color: #2A2A2A; color: #555; }

    .v4-verdict { padding: 22px 24px; border-bottom: 1px solid #1A1A1A; display: flex; align-items: center; justify-content: space-between; }
    .v4-verdict-label { font-size: 10px; font-weight: 700; letter-spacing: 2.5px; color: #555; text-transform: uppercase; margin-bottom: 8px; }
    .v4-verdict-text { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .v4-score-bar { margin-top: 10px; height: 4px; background: #1A1A1A; border-radius: 2px; overflow: hidden; width: 240px; }
    .v4-score-fill { height: 100%; transition: width 0.5s; }
    .verde .v4-verdict-text { color: #16A34A; }
    .verde .v4-score-fill { background: #16A34A; }
    .verde { border-top: 3px solid #16A34A; }
    .amarelo .v4-verdict-text { color: #D97706; }
    .amarelo .v4-score-fill { background: #D97706; }
    .amarelo { border-top: 3px solid #D97706; }
    .vermelho .v4-verdict-text { color: #CC1414; }
    .vermelho .v4-score-fill { background: #CC1414; }
    .vermelho { border-top: 3px solid #CC1414; }

    .v4-copy { background: #1A1A1A; border: 1px solid #2A2A2A; color: #666; padding: 6px 12px; border-radius: 7px; font-size: 11px; cursor: pointer; font-family: inherit; transition: all 0.15s; flex-shrink: 0; }
    .v4-copy:hover { border-color: #444; color: #999; }

    .v4-result-body { padding: 20px 24px; }
    .v4-pre { font-family: 'IBM Plex Mono', 'SF Mono', Menlo, monospace; font-size: 12px; line-height: 1.9; color: #C4C4C4; white-space: pre-wrap; word-break: break-word; margin: 0; }

    .v4-error { padding: 50px 24px; text-align: center; }
    .v4-error-icon { font-size: 32px; margin-bottom: 12px; }
    .v4-error-title { color: #CC1414; font-weight: 700; font-size: 15px; margin-bottom: 8px; }
    .v4-error-msg { color: #666; font-size: 12px; line-height: 1.6; }

    /* ── status integrações + janela 10s + lead tag (v6.3) ── */
    #v4-health { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 22px; border-bottom:1px solid #1A1A1A; background:#0A0A0A; }
    .v4-chip { font-size:10px; font-weight:700; letter-spacing:.3px; padding:3px 8px; border-radius:5px; border:1px solid #2A2A2A; color:#999; background:rgba(255,255,255,.03); white-space:nowrap; }
    .v4-chip b { color:#ddd; font-weight:800; }
    .v4-chip-on { border-color:#16A34A40; }
    .v4-chip-off { border-color:#CC141440; background:rgba(204,20,20,.08); }
    .v4-chip-auth { border-color:#D9770640; background:rgba(217,119,6,.08); }
    .v4-chip-warn { border-color:#D9770630; }
    .v4-chip-unset { opacity:.55; }
    .v4-health-loading { font-size:10px; color:#777; }
    .v4-health-refresh { margin-left:auto; background:none; border:1px solid #2A2A2A; color:#777; width:24px; height:24px; border-radius:5px; cursor:pointer; font-size:12px; }
    .v4-health-refresh:hover { border-color:#444; color:#bbb; }
    #v4-fab-badge { position:absolute; top:-4px; right:-4px; width:12px; height:12px; border-radius:50%; border:2px solid #0E0E0E; background:#777; }
    #v4-window { padding:8px 22px; border-bottom:1px solid #1A1A1A; background:#0C0C0C; }
    .v4-window-row { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
    .v4-window-clock { font-size:14px; font-weight:800; font-variant-numeric:tabular-nums; }
    .v4-window-hint { font-size:10px; color:#888; line-height:1.3; }
    .v4-window-track { height:3px; background:#1A1A1A; border-radius:2px; overflow:hidden; }
    .v4-window-fill { height:100%; transition:width 1s linear; }
    #v4-leadtag { display:flex; align-items:center; gap:8px; padding:8px 22px; border-bottom:1px solid #1A1A1A; background:#111; font-size:12px; color:#bbb; }
    .v4-leadtag-dot { width:7px; height:7px; border-radius:50%; background:#CC1414; box-shadow:0 0 6px rgba(204,20,20,.6); flex-shrink:0; }
    .v4-leadtag-txt b { color:#fff; }
  `);

  // ═══════════════════════════════════════════════════════════════
  // DOM
  // ═══════════════════════════════════════════════════════════════
  const fab = document.createElement('button');
  fab.id = 'v4-fab';
  fab.innerHTML = '<span style="font-size:14px">🔴</span><span>Analisar Lead</span>';
  document.body.appendChild(fab);

  const overlay = document.createElement('div');
  overlay.id = 'v4-overlay';
  overlay.innerHTML = `
    <div id="v4-panel">
      <div id="v4-header">
        <div class="v4-brand">
          <div class="v4-dot"></div>
          <span class="v4-brand-name">V4 Lead Analyzer · LDR</span>
          <span class="v4-cache-badge" id="v4-cache-badge" style="display:none">CACHE</span>
        </div>
        <button id="v4-close" title="Fechar (ESC)">✕</button>
      </div>
      <div id="v4-mode-bar">
        <button class="v4-mode-btn active" data-mode="express" id="v4-mode-express">🚀 EXPRESS</button>
        <button class="v4-mode-btn" data-mode="garimpo" id="v4-mode-garimpo">🔍 GARIMPO</button>
        <span class="v4-mode-hint" id="v4-mode-hint">Express: 4-6s · busca OutboundPro + análise</span>
      </div>
      <div id="v4-body"></div>
      <div id="v4-footer">
        <button class="v4-btn-sec" id="v4-key">⚙ API Keys</button>
        <button class="v4-btn-sec" id="v4-clear-cache">🗑 Limpar cache</button>
        <button class="v4-btn-sec" id="v4-new">↩ Nova análise</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = document.getElementById('v4-body');
  const panel = document.getElementById('v4-panel');
  const cacheBadge = document.getElementById('v4-cache-badge');
  const modeHint = document.getElementById('v4-mode-hint');

  let currentMode = 'express';

  // estado de run / lead / janela / saúde (v6.3)
  let v4RunId = 0;
  let v4CurrentLead = null;
  let v4WindowTimer = null;
  let v4Health = null;
  let v4HealthAt = 0;

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════
  function openPanel() { overlay.classList.add('active'); panel.className = ''; }
  function closePanel() { overlay.classList.remove('active'); }
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getOpenAIKey() {
    let k = GM_getValue('v4_openai_key', '');
    if (k) return k;
    k = prompt(
      '🔴 V4 Lead Analyzer — Chave OpenAI\n\n' +
      'Cole sua chave OpenAI (sk-...)\n' +
      'Encontre em: platform.openai.com/api-keys\n\n' +
      'Salva uma vez no navegador.'
    );
    if (!k?.trim().startsWith('sk-')) { alert('Chave inválida.'); return null; }
    GM_setValue('v4_openai_key', k.trim());
    return k.trim();
  }

  function getGeminiKey() {
    let k = GM_getValue('v4_gemini_key', '');
    if (k) return k;
    k = prompt(
      '🔴 V4 Lead Analyzer — Chave Gemini\n\n' +
      'Cole sua chave API do Gemini\n' +
      'Encontre em: aistudio.google.com/apikey\n\n' +
      'IMPORTANTE: ative billing para evitar "high demand".\n' +
      'Salva uma vez no navegador.\n\n' +
      '(Cancele se não tiver — sistema usa OpenAI como fallback)'
    );
    if (!k?.trim() || k.trim().length < 20) return null;
    GM_setValue('v4_gemini_key', k.trim());
    return k.trim();
  }

  function getOutboundProToken() {
    let k = GM_getValue('v4_outbound_token', '');
    if (k) return k;
    k = prompt(
      '🔴 V4 Lead Analyzer — Token OutboundPro\n\n' +
      'Cole seu token (chave privada do cliente)\n' +
      'Encontre em: OutboundPro → Configurações\n\n' +
      'Salva uma vez no navegador.'
    );
    if (!k?.trim() || k.trim().length < 10) { alert('Token inválido.'); return null; }
    GM_setValue('v4_outbound_token', k.trim());
    return k.trim();
  }

  // ═══════════════════════════════════════════════════════════════
  // CACHE
  // ═══════════════════════════════════════════════════════════════
  function hashLead(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    return 'lead_' + Math.abs(h).toString(36);
  }

  function getCached(text, mode) {
    const key = hashLead(text + '_' + mode);
    const cached = GM_getValue(key, null);
    if (!cached) return null;
    try {
      const data = JSON.parse(cached);
      if (Date.now() - data.timestamp < 7 * 24 * 3600 * 1000) return data.result;
    } catch (e) {}
    return null;
  }

  function setCache(text, mode, result) {
    const key = hashLead(text + '_' + mode);
    GM_setValue(key, JSON.stringify({ result, timestamp: Date.now() }));
  }

  function clearAllCache() {
    if (typeof GM_listValues !== 'undefined') {
      GM_listValues().forEach(k => { if (k.startsWith('lead_')) GM_setValue(k, ''); });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PARSER DE VALOR BR (corrige bug "mi" dentro de "mil")
  // ═══════════════════════════════════════════════════════════════
  function parseValorBR(token) {
    let t = String(token).toLowerCase().replace(/r\$\s*/g, '').trim();
    let mult = 1;
    if (/milh(?:ão|ões|ao|oes)|\bmi\b/.test(t)) mult = 1000000;
    else if (/\bmil\b|\bk\b/.test(t)) mult = 1000;
    let numStr = t.replace(/[^\d.,]/g, '');
    let n = parseFloat(numStr.replace(/\./g, '').replace(',', '.'));
    if (isNaN(n)) return 0;
    return Math.round(n * mult);
  }

  // ═══════════════════════════════════════════════════════════════
  // PRÉ-EXTRAÇÃO LOCAL
  // ═══════════════════════════════════════════════════════════════
  function preExtract(text) {
    const data = {
      cnpj: null, cnpjVisivel: false, cnpjParcial: null,
      nomeEmpresa: null, nomeContato: null, cargo: null,
      email: null, emailDomain: null, telefone: null, ddd: null,
      faturamento: null, faturamentoMin: 0, faturamentoMax: 0,
      segmento: null, canal: null, urgencia: null,
      cidade: null, estado: null,
      tier: null, zona: null, tipoProduto: null,
      horaLead: null, isNoturno: false,
    };

    const cnpjMatch = text.match(/(\d{2})[\.\s]?(\d{3})[\.\s]?(\d{3})[\/\s]?(\d{4})[-\s]?(\d{2})/);
    if (cnpjMatch && !text.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}\*+/)) {
      data.cnpj = `${cnpjMatch[1]}.${cnpjMatch[2]}.${cnpjMatch[3]}/${cnpjMatch[4]}-${cnpjMatch[5]}`;
      data.cnpjVisivel = true;
    }

    if (!data.cnpjVisivel) {
      const parcialMatch = text.match(/Documento\s+da\s+empresa[:\s\n]+([\d\.\/]+?\*+)/i)
                       || text.match(/CNPJ[:\s\n]+([\d\.\/]+?\*+)/i)
                       || text.match(/(\d{2}\.\d{3}(?:\.\d{0,3})?(?:\/\d{0,4})?)\*+/);
      if (parcialMatch) {
        const onlyDigits = parcialMatch[1].replace(/[^\d]/g, '');
        if (onlyDigits.length >= 4) data.cnpjParcial = onlyDigits;
      }
    }

    const extract = (label) => {
      const re = new RegExp(`${label}[:\\s]+\\n?\\s*([^\\n]+)`, 'i');
      const m = text.match(re);
      if (m && m[1] && !m[1].trim().match(/^[*\-\s]+$/)) return m[1].trim();
      return null;
    };

    data.nomeEmpresa = extract('Nome da empresa');
    data.nomeContato = extract('Nome do responsável');
    data.cargo = extract('Cargo');
    data.email = extract('E-mail') || extract('Email');
    data.faturamento = extract('Faturamento');
    data.segmento = extract('Segmento');
    data.canal = extract('Canal');
    data.urgencia = extract('Urgência');
    data.cidade = extract('Cidade');
    data.estado = extract('Estado');
    data.tipoProduto = extract('Tipo de produto');
    data.telefone = extract('Telefone');

    const dataMatch = text.match(/Data\s+de\s+cria[çc][ãa]o[:\s\n]+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}):(\d{2})/i);
    if (dataMatch) {
      const hora = parseInt(dataMatch[2]);
      data.horaLead = hora;
      data.isNoturno = (hora >= 22 || hora < 7);
    }

    if (data.email && data.email.includes('@')) {
      data.emailDomain = data.email.split('@')[1]?.toLowerCase().split(/\s|\./)[0];
    }

    if (data.telefone) {
      const dddMatch = data.telefone.match(/\+?55\s*\(?(\d{2})/);
      if (dddMatch) data.ddd = parseInt(dddMatch[1]);
    }

    // FATURAMENTO — parser corrigido (não confunde "mil" com "milhão")
    if (data.faturamento) {
      const f = data.faturamento.toLowerCase();
      const tokens = f.match(/r?\$?\s*\d[\d.,]*\s*(?:milh(?:ões|ão|oes|ao)|mil|mi|k)?/gi) || [];
      let valores = tokens.map(parseValorBR).filter(v => v > 0);
      // EDGE: "De 1 à 5 milhões" — só o último token tem unidade. Propaga p/ o menor.
      if (valores.length === 2 && valores[1] / valores[0] >= 100 && valores[0] < 1000) {
        const mult = valores[1] >= 1000000 ? 1000000 : 1000;
        valores[0] = valores[0] * mult;
      }
      if (valores.length >= 2) {
        data.faturamentoMin = Math.min(...valores);
        data.faturamentoMax = Math.max(...valores);
      } else if (valores.length === 1) {
        data.faturamentoMin = valores[0];
        data.faturamentoMax = valores[0];
      }
    }

    const fatRef = data.faturamentoMin;
    if (fatRef >= 40000000) data.tier = 'ENTERPRISE';
    else if (fatRef >= 16100000) data.tier = 'LARGE-PLUS';
    else if (fatRef >= 4100000) data.tier = 'LARGE';
    else if (fatRef >= 1000000) data.tier = 'MEDIUM-PLUS';
    else if (fatRef >= 400000) data.tier = 'MEDIUM';
    else if (fatRef >= 100000) data.tier = 'SMALL';
    else if (fatRef > 0) data.tier = 'TINY';

    const zonaVerde = [11,12,13,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,64,65,66,67];
    const zonaAmarela = [71,73,74,75,77,79,81,84,85,87,88,91,92,93,94,97];
    const zonaVermelha = [82,83,86,89,95,96,98,99,63,68,69];

    if (data.ddd) {
      if (zonaVerde.includes(data.ddd)) data.zona = 'Verde';
      else if (zonaAmarela.includes(data.ddd)) data.zona = 'Amarela';
      else if (zonaVermelha.includes(data.ddd)) data.zona = 'Vermelha';
      else data.zona = 'Desconhecida';
    }

    return data;
  }

  // ═══════════════════════════════════════════════════════════════
  // TABELA DE LANCES POR TIER (LeadBroker oficial V4)
  // ═══════════════════════════════════════════════════════════════
  const LANCES_INICIAIS = {
    'TINY_50_70':    { lance: 208, compreJa: 374 },
    'TINY_70_100':   { lance: 260, compreJa: 468 },
    'SMALL_100_200': { lance: 498, compreJa: 896 },
    'SMALL_200_400': { lance: 598, compreJa: 1076 },
    'MEDIUM':        { lance: 686, compreJa: 1235 },
    'MEDIUM_PLUS':   { lance: 884, compreJa: 1591 },
    'LARGE':         { lance: null, compreJa: null },
    'LARGE_PLUS':    { lance: null, compreJa: null },
    'ENTERPRISE':    { lance: null, compreJa: null },
  };

  function getLanceInfo(ex) {
    if (ex.tier === 'TINY') return ex.faturamentoMin >= 70000 ? LANCES_INICIAIS.TINY_70_100 : LANCES_INICIAIS.TINY_50_70;
    if (ex.tier === 'SMALL') return ex.faturamentoMin >= 200000 ? LANCES_INICIAIS.SMALL_200_400 : LANCES_INICIAIS.SMALL_100_200;
    if (ex.tier === 'MEDIUM') return LANCES_INICIAIS.MEDIUM;
    if (ex.tier === 'MEDIUM-PLUS') return LANCES_INICIAIS.MEDIUM_PLUS;
    if (ex.tier === 'LARGE') return LANCES_INICIAIS.LARGE;
    if (ex.tier === 'LARGE-PLUS') return LANCES_INICIAIS.LARGE_PLUS;
    if (ex.tier === 'ENTERPRISE') return LANCES_INICIAIS.ENTERPRISE;
    return { lance: null, compreJa: null };
  }

  function formatBRL(v) {
    if (v == null) return 'sob consulta';
    return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // VETOS (sinais DUROS de spam/bot)
  // ═══════════════════════════════════════════════════════════════
  function detectarVetos(ex, rawText) {
    const vetos = [];
    if (ex.nomeContato) {
      const n = ex.nomeContato.trim();
      const partes = n.split(/\s+/).filter(p => p.length > 0);
      if (/_[a-z]{2,}$|_[a-z]+_/i.test(n) && !/^[A-ZÀ-Ú]/.test(n)) {
        vetos.push('Nome contato com underscores (padrão bot)');
      } else if (partes.length === 1 && n.length >= 8 && n === n.toLowerCase() && /^[a-z]+$/.test(n)) {
        vetos.push('Nome contato em formato de username');
      } else if (partes.length >= 4) {
        const meio = Math.floor(partes.length / 2);
        const primeira = partes.slice(0, meio).join(' ').toLowerCase();
        const segunda = partes.slice(meio).join(' ').toLowerCase();
        const distancia = primeira.length > 0 && segunda.length > 0
          ? (primeira === segunda ? 0 : (primeira.includes(segunda) || segunda.includes(primeira) ? 1 : 99))
          : 99;
        let similar = 0;
        for (let i = 0; i < Math.min(primeira.length, segunda.length); i++) {
          if (primeira[i] === segunda[i]) similar++;
        }
        const taxaSimilar = primeira.length > 0 ? similar / Math.max(primeira.length, segunda.length) : 0;
        if (distancia <= 1 || taxaSimilar > 0.7) vetos.push('Nome contato repetido (padrão bot/erro)');
      }
      if (/[0-9]{3,}/.test(n) || /[a-z]{8,}[A-Z]/.test(n)) vetos.push('Nome contato com caracteres suspeitos');
    }
    if (ex.email && ex.email.includes('@')) {
      const dom = ex.email.split('@')[1]?.toLowerCase() || '';
      const dominiosInvalidos = ['igmail', 'gnail', 'gmial', 'hotmal', 'hotnail', 'yahoocom', 'outloook'];
      if (dominiosInvalidos.some(d => dom.startsWith(d))) vetos.push(`Email com typo: ${dom.split('.')[0]} não existe`);
    }
    if (ex.nomeEmpresa) {
      const e = ex.nomeEmpresa.trim().toLowerCase();
      const palavrasGenericas = ['teste', 'test', 'asdf', 'qwerty', 'abc', 'xxx', 'aaa'];
      if (palavrasGenericas.some(p => e === p || e === p + ' ' + p)) vetos.push('Nome empresa = padrão de teste/spam');
      if (/^[0-9\s]+$/.test(e) || /^[^a-zà-ú]+$/i.test(e)) vetos.push('Nome empresa sem letras válidas');
    }
    return vetos;
  }

  // ═══════════════════════════════════════════════════════════════
  // FLAGS DE CAUTELA (sinais fracos — não bloqueiam, rebaixam p/ 🟡)
  // ═══════════════════════════════════════════════════════════════
  function detectarFlagsCautela(ex, rawText) {
    const flags = [];
    const camposVazios = [];
    if (!ex.cargo || /n[ãa]o\s*informado/i.test(ex.cargo)) camposVazios.push('cargo');
    if (!ex.urgencia || /n[ãa]o\s*informado/i.test(ex.urgencia)) camposVazios.push('urgência');
    if (!ex.cidade || /n[ãa]o\s*informado/i.test(ex.cidade)) camposVazios.push('cidade');
    if (!ex.estado || /n[ãa]o\s*informado/i.test(ex.estado)) camposVazios.push('estado');
    const semDescricao = !rawText.match(/Descri[çc][ãa]o[:\s\n]+\S+(?![\s\n]*N[ãa]o)/i);
    if (semDescricao) camposVazios.push('descrição');
    const semCnpj = !ex.cnpjVisivel && !ex.cnpjParcial;
    if (camposVazios.length >= 5 && semCnpj) {
      flags.push(`${camposVazios.length} campos vazios + CNPJ não detectado — SDR confirma na ligação`);
    }
    if (ex.isNoturno) flags.push(`Lead noturno (${ex.horaLead}h) — validar autenticidade`);
    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // SCORE LOCAL (0-100 normalizado)
  // ═══════════════════════════════════════════════════════════════
  function computeLocalScore(ex) {
    let scoreCnpj = 0, scoreTier = 0, scoreCanal = 0, scoreMaterial = 0, scoreGeo = 0;
    if (ex.cnpjVisivel) scoreCnpj = 15;
    else if (ex.cnpjParcial) scoreCnpj = 15;
    if (['MEDIUM-PLUS','LARGE','LARGE-PLUS','ENTERPRISE'].includes(ex.tier)) scoreTier = 30;
    else if (ex.tier === 'MEDIUM') scoreTier = 30;
    else if (ex.tier === 'SMALL') scoreTier = 25;
    else if (ex.tier === 'TINY') scoreTier = 15;
    const canal = (ex.canal || '').toLowerCase();
    const urgente = ex.urgencia && /imediato|imediatamente/i.test(ex.urgencia);
    if (/google|org[âa]nico/i.test(canal)) scoreCanal = urgente ? 25 : 18;
    else if (/institucional/i.test(canal)) scoreCanal = urgente ? 15 : 10;
    else if (/instagram/i.test(canal)) scoreCanal = urgente ? 8 : 5;
    else if (/facebook|tiktok/i.test(canal)) scoreCanal = 3;
    if (ex.cidade && !/n[ãa]o\s*informado/i.test(ex.cidade)) scoreMaterial += 5;
    if (ex.estado && !/n[ãa]o\s*informado/i.test(ex.estado)) scoreMaterial += 5;
    if (ex.emailDomain && !['gmail','hotmail','outlook','yahoo','icloud','bol','terra','live','msn'].includes(ex.emailDomain)) scoreMaterial += 5;
    if (ex.zona === 'Verde') scoreGeo = 10;
    else if (ex.zona === 'Amarela') scoreGeo = 5;
    else if (ex.zona === 'Vermelha') scoreGeo = 0;

    const totalBruto = scoreCnpj + scoreTier + scoreCanal + scoreMaterial + scoreGeo; // máx 95
    const total = Math.round(totalBruto / 95 * 100); // normaliza 0-100
    return {
      total,
      breakdown: { cnpj: scoreCnpj, tier: scoreTier, canal: scoreCanal, materialidade: scoreMaterial, geografico: scoreGeo }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DECISÃO LOCAL
  // ═══════════════════════════════════════════════════════════════
  function computeLocalDecision(ex, rawText) {
    const vetos = detectarVetos(ex, rawText);
    const flags = detectarFlagsCautela(ex, rawText);
    const score = computeLocalScore(ex);
    const lance = getLanceInfo(ex);
    const temCnpj = ex.cnpjVisivel || ex.cnpjParcial != null;

    let acao, color, label, motivos = [];

    if (vetos.length > 0) {
      acao = 'NAO_COMPRAR_VETO'; color = 'vermelho'; label = '🛑 NÃO COMPRAR'; motivos = vetos;
    } else if (score.total < 40) {
      acao = 'NAO_COMPRAR'; color = 'vermelho'; label = '🔴 NÃO COMPRAR';
      motivos = ['Score local baixo — sinais insuficientes para arriscar lance obrigatório'];
    } else if (score.total >= 80 && temCnpj && ex.tier && ex.tier !== 'TINY' && flags.length === 0) {
      acao = 'COMPRE_JA'; color = 'verde'; label = '💰 COMPRE JÁ';
      motivos = ['Sinais fortes em todas as frentes — garante antes da disputa'];
    } else if (score.total >= 60 && flags.length === 0) {
      acao = 'DA_LANCE'; color = 'verde'; label = '🟢 DÁ LANCE INICIAL';
      motivos = ['Sinais positivos — vale o lance inicial baixo'];
    } else {
      acao = 'LANCE_CAUTELA'; color = 'amarelo'; label = '🟡 LANCE COM CAUTELA';
      motivos = flags.length ? flags : ['Score médio — dá lance só se confiar que vai ter disputa'];
    }

    return { acao, color, label, motivos, score, vetos, flags, lance: lance.lance, compreJa: lance.compreJa };
  }

  // ═══════════════════════════════════════════════════════════════
  // STATUS DE INTEGRAÇÕES (On/Off)
  // ═══════════════════════════════════════════════════════════════
  function classifyHealth(status) {
    if (status === null) return 'unset';
    if (status >= 200 && status < 300) return 'on';
    if (status === 401 || status === 403 || status === 400) return 'auth';
    if (status <= 0) return 'off';
    return 'warn';
  }

  const HEALTH_META = {
    on:    { dot: '🟢', txt: 'ON' },
    off:   { dot: '🔴', txt: 'OFF' },
    auth:  { dot: '🟠', txt: 'CHAVE?' },
    warn:  { dot: '🟡', txt: '?' },
    unset: { dot: '⚪', txt: 'n/d' },
  };

  function pingHealth(opts) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: opts.timeout || 6000,
        onload:  r => resolve(r.status),
        onerror: () => resolve(0),
        ontimeout: () => resolve(-1),
      });
    });
  }

  async function checkOpenAI() {
    const key = GM_getValue('v4_openai_key', '');
    if (!key) return { state: 'unset', status: null };
    const st = await pingHealth({ url: 'https://api.openai.com/v1/models', headers: { 'Authorization': 'Bearer ' + key } });
    return { state: classifyHealth(st), status: st };
  }

  async function checkGemini() {
    const key = GM_getValue('v4_gemini_key', '');
    if (!key) return { state: 'unset', status: null };
    const st = await pingHealth({ url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key) });
    return { state: classifyHealth(st), status: st };
  }

  async function checkOutbound() {
    const token = GM_getValue('v4_outbound_token', '');
    if (!token) return { state: 'unset', status: null };
    const endpoint = GM_getValue('v4_outbound_health_endpoint', '');
    const st = await pingHealth({
      url: 'https://app.outboundpro.com.br/api' + endpoint,
      headers: { 'Token': token, 'Content-Type': 'application/json' }
    });
    return { state: classifyHealth(st), status: st };
  }

  async function checkBrasil() {
    const st = await pingHealth({ url: 'https://brasilapi.com.br/api/cnpj/v1/00000000000191' });
    return { state: classifyHealth(st), status: st };
  }

  async function v4RefreshHealth(force) {
    if (!force && v4Health && (Date.now() - v4HealthAt < 60000)) {
      renderHealthStrip();
      return v4Health;
    }
    renderHealthStrip(true);
    const [openai, gemini, outbound, brasil] = await Promise.all([
      checkOpenAI(), checkGemini(), checkOutbound(), checkBrasil()
    ]);
    v4Health = { openai, gemini, outbound, brasil };
    v4HealthAt = Date.now();
    renderHealthStrip();
    updateFabBadge();
    return v4Health;
  }

  function healthIsCritical() {
    if (!v4Health) return null;
    const bad = s => s === 'off' || s === 'auth';
    return bad(v4Health.openai.state) || bad(v4Health.outbound.state);
  }

  function ensureHealthStrip() {
    let strip = document.getElementById('v4-health');
    if (strip) return strip;
    strip = document.createElement('div');
    strip.id = 'v4-health';
    const modeBar = document.getElementById('v4-mode-bar');
    modeBar.parentNode.insertBefore(strip, modeBar.nextSibling);
    return strip;
  }

  function chip(label, h) {
    const meta = HEALTH_META[h.state] || HEALTH_META.unset;
    const code = (h.status && h.status > 0) ? ` ${h.status}` : '';
    return `<span class="v4-chip v4-chip-${h.state}" title="${label}: ${meta.txt}${code}">${meta.dot} ${label} <b>${meta.txt}${code}</b></span>`;
  }

  function renderHealthStrip(loading) {
    const strip = ensureHealthStrip();
    if (loading || !v4Health) {
      strip.innerHTML = `<span class="v4-health-loading">⏳ verificando integrações...</span><button class="v4-health-refresh" id="v4-health-refresh">↻</button>`;
    } else {
      strip.innerHTML =
        chip('OpenAI', v4Health.openai) +
        chip('Gemini', v4Health.gemini) +
        chip('OutboundPro', v4Health.outbound) +
        chip('BrasilAPI', v4Health.brasil) +
        `<button class="v4-health-refresh" id="v4-health-refresh" title="Recheck">↻</button>`;
    }
    const btn = document.getElementById('v4-health-refresh');
    if (btn) btn.onclick = () => v4RefreshHealth(true);
  }

  function updateFabBadge() {
    let badge = document.getElementById('v4-fab-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'v4-fab-badge';
      fab.appendChild(badge);
    }
    const crit = healthIsCritical();
    badge.style.background = crit === null ? '#777' : crit ? '#CC1414' : '#16A34A';
    badge.title = crit ? 'Integração crítica OFF — só decisão local confiável' : 'Integrações OK';
  }

  // ═══════════════════════════════════════════════════════════════
  // JANELA DE 10s (regra LeadBroker)
  // ═══════════════════════════════════════════════════════════════
  function ensureWindowBar() {
    let bar = document.getElementById('v4-window');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'v4-window';
    const strip = ensureHealthStrip();
    strip.parentNode.insertBefore(bar, strip.nextSibling);
    return bar;
  }

  function v4StartWindow(seconds) {
    const total = seconds || 10;
    const bar = ensureWindowBar();
    const crit = healthIsCritical();
    const aviso = crit
      ? '⚠️ Integração crítica OFF — decida SÓ pelo bloco local abaixo'
      : 'Decida pelo bloco local; a análise de IA é confirmação';
    let restante = total;
    if (v4WindowTimer) clearInterval(v4WindowTimer);
    const paint = () => {
      const pct = Math.max(0, (restante / total) * 100);
      const cor = restante > 4 ? '#16A34A' : restante > 0 ? '#D97706' : '#CC1414';
      bar.innerHTML = `
        <div class="v4-window-row">
          <span class="v4-window-clock" style="color:${cor}">⏱ ${restante > 0 ? restante.toFixed(0) + 's' : 'tempo esgotado'}</span>
          <span class="v4-window-hint">${restante > 0 ? aviso : 'Use a decisão local (0s) — não espere a IA'}</span>
        </div>
        <div class="v4-window-track"><div class="v4-window-fill" style="width:${pct}%;background:${cor}"></div></div>`;
    };
    paint();
    v4WindowTimer = setInterval(() => {
      restante -= 1;
      paint();
      if (restante <= 0) clearInterval(v4WindowTimer);
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════
  // RESET + RÓTULO DO LEAD (anti-sobreposição)
  // ═══════════════════════════════════════════════════════════════
  function resetAnalysisUI() {
    panel.className = '';
    cacheBadge.style.display = 'none';
    body.innerHTML = '';
    const win = document.getElementById('v4-window');
    if (win) win.innerHTML = '';
    if (v4WindowTimer) { clearInterval(v4WindowTimer); v4WindowTimer = null; }
  }

  function renderLeadTag(extracted) {
    const emp = extracted.nomeEmpresa || 'Empresa não identificada';
    const ctt = extracted.nomeContato ? ` · ${escapeHtml(extracted.nomeContato)}` : '';
    let tag = document.getElementById('v4-leadtag');
    if (!tag) {
      tag = document.createElement('div');
      tag.id = 'v4-leadtag';
      body.parentNode.insertBefore(tag, body);
    }
    tag.innerHTML = `<span class="v4-leadtag-dot"></span><span class="v4-leadtag-txt">Avaliando: <b>${escapeHtml(emp)}</b>${ctt}</span>`;
  }

  // ═══════════════════════════════════════════════════════════════
  // BLOCO DE PROCEDÊNCIA ("o que de fato foi verificado")
  // ═══════════════════════════════════════════════════════════════
  function buildProvenance(extracted, searchResults, contactSearch) {
    const L = [];
    L.push('🧾 VERIFICAÇÕES EXECUTADAS (procedência)');
    L.push('─────────────────────────────────────────');
    const cnpjStatus = extracted.cnpjVisivel ? '✅ visível no lead'
      : extracted.cnpjParcial ? `⚠️ parcial (${extracted.cnpjParcial}***)`
      : '❌ mascarado / não detectado';
    L.push(`• CNPJ no lead: ${cnpjStatus}`);
    if (searchResults?.empresa) {
      L.push(`• OutboundPro/Receita: ✅ empresa localizada (fonte: ${searchResults.source})`);
      const qsa = searchResults.empresa.contatos || searchResults.empresa.qsa || [];
      L.push(`   ↳ QSA: ${qsa.length ? `✅ ${qsa.length} sócio(s)` : '⚠️ vazio'}`);
      const mt = searchResults.match_type;
      L.push(`   ↳ Match do decisor: ${mt === 'exato' ? '✅ confirmado no QSA' : mt === 'parcial' ? '⚠️ parcial (LDR confirma visualmente)' : '❌ não validado'}`);
    } else {
      L.push('• OutboundPro/Receita: ❌ empresa NÃO localizada ou API sem resposta');
      L.push('   ⚠️ Se isso aparece em TODO lead, é integração caída — não lead ruim.');
    }
    if (contactSearch?.found) {
      const fonte = contactSearch.source === 'gemini' ? 'Gemini + Google Search'
        : contactSearch.source === 'openai_search' ? 'OpenAI Search' : contactSearch.source;
      L.push(`• Investigação web do contato: ✅ via ${fonte}`);
      const inv = contactSearch.raw || {};
      if (inv.linkedin_url) L.push(`   ↳ LinkedIn: ${inv.linkedin_url}`);
      if (inv.match_confidence) L.push(`   ↳ Confiança do match: ${String(inv.match_confidence).toUpperCase()}`);
      if (inv.is_franquia) L.push(`   ↳ Franquia detectada: ${inv.rede_franquia || 'rede n/d'}`);
      if (inv.presenca_digital) L.push(`   ↳ Presença digital: ${inv.presenca_digital}`);
    } else if (extracted.nomeContato) {
      L.push('• Investigação web do contato: ❌ nenhum resultado (Gemini e OpenAI)');
    } else {
      L.push('• Investigação web do contato: ⏭️ não rodou (sem nome de contato no lead)');
    }
    L.push('─────────────────────────────────────────');
    L.push('');
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  function renderInstant(decision, extracted) {
    const items = [
      ['Empresa', extracted.nomeEmpresa],
      ['Contato', extracted.nomeContato],
      ['Tier', extracted.tier],
      ['Zona', extracted.zona],
      ['CNPJ', extracted.cnpjVisivel ? '✓ visível'
              : extracted.cnpjParcial ? `parcial: ${extracted.cnpjParcial}***`
              : 'mascarado'],
      ['Canal', extracted.canal],
      extracted.isNoturno ? ['🌙 Lead noturno', `${extracted.horaLead}h`] : null,
    ].filter(x => x && x[1]);

    const valoresHtml = (decision.lance != null) ? `
      <div class="v4-valores">
        <div class="v4-valor-item">
          <div class="v4-valor-label">Lance inicial</div>
          <div class="v4-valor-num">${formatBRL(decision.lance)}</div>
        </div>
        <div class="v4-valor-divider"></div>
        <div class="v4-valor-item">
          <div class="v4-valor-label">Compre Já (1,8x)</div>
          <div class="v4-valor-num">${formatBRL(decision.compreJa)}</div>
        </div>
      </div>
    ` : `
      <div class="v4-valores">
        <div class="v4-valor-item" style="width:100%">
          <div class="v4-valor-label">Valores</div>
          <div class="v4-valor-num" style="font-size:14px">Tier ${extracted.tier || '?'} — sob consulta</div>
        </div>
      </div>
    `;

    const motivosHtml = decision.motivos.length > 0 ? `
      <div class="v4-motivos">
        ${decision.motivos.map(m => `<div class="v4-motivo">• ${escapeHtml(m)}</div>`).join('')}
      </div>
    ` : '';

    const b = decision.score.breakdown;
    const scoreHtml = `
      <div class="v4-score-breakdown">
        <div class="v4-score-title">Score local: <strong>${decision.score.total}/100</strong></div>
        <div class="v4-score-pills">
          <span class="v4-pill">CNPJ ${b.cnpj}/15</span>
          <span class="v4-pill">Tier ${b.tier}/30</span>
          <span class="v4-pill">Canal ${b.canal}/25</span>
          <span class="v4-pill">Materialidade ${b.materialidade}/15</span>
          <span class="v4-pill">Geo ${b.geografico}/10</span>
        </div>
      </div>
    `;

    body.innerHTML = `
      <div class="v4-instant ${decision.color}">
        <div class="v4-instant-label">
          <div class="v4-instant-pulse"></div>
          Decisão local · 0 segundos
        </div>
        <div class="v4-instant-text">${decision.label}</div>
        ${valoresHtml}
        ${motivosHtml}
        ${scoreHtml}
      </div>
      <div class="v4-extracted">
        <div class="v4-extracted-grid">
          ${items.map(([k, v]) => `
            <div class="v4-extracted-item">
              <strong>${k}:</strong> ${escapeHtml(String(v))}
            </div>
          `).join('')}
        </div>
      </div>
      <div class="v4-progress">
        <div class="v4-steps">
          <div class="v4-step done" id="v4-step-1">
            <div class="v4-step-icon">✓</div>
            <span>Pré-análise local · ${extracted.tier || '?'} · Zona ${extracted.zona || '?'}</span>
          </div>
          <div class="v4-step active" id="v4-step-2">
            <div class="v4-step-icon">○</div>
            <span>${decision.acao.includes('NAO_COMPRAR') ? 'Investigando mesmo assim (validação)' : 'Buscando empresa no OutboundPro...'}</span>
          </div>
          <div class="v4-step" id="v4-step-3">
            <div class="v4-step-icon">·</div>
            <span>Validando QSA + dados ricos</span>
          </div>
          <div class="v4-step" id="v4-step-4">
            <div class="v4-step-icon">·</div>
            <span>Análise final com gpt-4o</span>
          </div>
        </div>
      </div>
    `;
  }

  function updateStep(stepNum, status, label) {
    const el = document.getElementById(`v4-step-${stepNum}`);
    if (!el) return;
    el.className = `v4-step ${status}`;
    const icon = el.querySelector('.v4-step-icon');
    icon.textContent = status === 'done' ? '✓' : status === 'active' ? '○' : status === 'skipped' ? '⤳' : '·';
    if (label) el.querySelector('span').textContent = label;
  }

  function renderResult(text, fromCache) {
    let cls = 'vermelho', icon = '🔴', label = 'NÃO COMPRAR';
    const scoreMatch = text.match(/SCORE:\s*(\d+)\s*\/\s*100/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    if (score >= 75) { cls = 'verde'; icon = '🟢'; label = 'ARREMATAR'; }
    else if (score >= 50) { cls = 'amarelo'; icon = '🟡'; label = 'RISCO CALCULADO'; }
    else { cls = 'vermelho'; icon = '🔴'; label = 'NÃO COMPRAR'; }

    if (!scoreMatch) {
      const veredictoLine = text.match(/VEREDITO:\s*([^\n]+)/i);
      const linha = veredictoLine ? veredictoLine[1] : '';
      if (/🟢|ARREMATAR/i.test(linha) && !/NÃO\s+ARREMATAR/i.test(linha)) {
        cls = 'verde'; icon = '🟢'; label = 'ARREMATAR';
      } else if (/🟡|RISCO\s+CALCULADO/i.test(linha)) {
        cls = 'amarelo'; icon = '🟡'; label = 'RISCO CALCULADO';
      }
    }

    panel.className = cls;
    cacheBadge.style.display = fromCache ? 'inline-block' : 'none';

    body.innerHTML = `
      <div class="v4-verdict">
        <div>
          <div class="v4-verdict-label">Veredito LDR · ${currentMode === 'garimpo' ? 'Garimpo' : 'Express'} ${fromCache ? '· cache' : ''}</div>
          <div class="v4-verdict-text">${icon} ${label}</div>
          <div class="v4-score-bar">
            <div class="v4-score-fill" style="width:${score}%"></div>
          </div>
        </div>
        <button class="v4-copy" id="v4-copy-result">Copiar</button>
      </div>
      <div class="v4-result-body">
        <pre class="v4-pre">${escapeHtml(text)}</pre>
      </div>
    `;

    document.getElementById('v4-copy-result').addEventListener('click', (e) => {
      navigator.clipboard.writeText(text);
      e.target.textContent = '✓ Copiado';
      setTimeout(() => e.target.textContent = 'Copiar', 2000);
    });
  }

  function renderError(msg) {
    panel.className = '';
    body.innerHTML = `
      <div class="v4-error">
        <div class="v4-error-icon">⚠️</div>
        <div class="v4-error-title">Erro na análise</div>
        <div class="v4-error-msg">${escapeHtml(msg)}</div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════
  // OPENAI API
  // ═══════════════════════════════════════════════════════════════
  function callOpenAI(systemInstruction, userContent, apiKey, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        data: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent }
          ],
          max_tokens: 2048,
          temperature: 0
        }),
        timeout: timeoutMs,
        onload(res) {
          try {
            const d = JSON.parse(res.responseText);
            if (d.error) { reject(new Error(d.error.message)); return; }
            const text = d.choices?.[0]?.message?.content || '';
            if (!text) { reject(new Error('Resposta OpenAI vazia')); return; }
            resolve(text.trim());
          } catch (e) { reject(new Error('Erro OpenAI: ' + e.message)); }
        },
        onerror() { reject(new Error('Erro rede (OpenAI)')); },
        ontimeout() { reject(new Error('Timeout OpenAI')); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GEMINI API com Google Search nativo
  // ═══════════════════════════════════════════════════════════════
  function callGemini(systemInstruction, userContent, apiKey, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
        tools: [{ google_search: {} }]
      };
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: timeoutMs,
        onload(res) {
          try {
            const d = JSON.parse(res.responseText);
            if (d.error) { reject(new Error(d.error.message || 'Erro Gemini')); return; }
            const text = d.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
            if (!text) { reject(new Error('Resposta Gemini vazia')); return; }
            resolve(text.trim());
          } catch (e) { reject(new Error('Erro Gemini: ' + e.message)); }
        },
        onerror() { reject(new Error('Erro rede (Gemini)')); },
        ontimeout() { reject(new Error('Timeout Gemini')); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // OPENAI SEARCH (fallback)
  // ═══════════════════════════════════════════════════════════════
  function callOpenAISearch(systemInstruction, userContent, apiKey, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        data: JSON.stringify({
          model: 'gpt-4o-mini-search-preview',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent }
          ],
          max_tokens: 1500,
          web_search_options: {}
        }),
        timeout: timeoutMs,
        onload(res) {
          try {
            const d = JSON.parse(res.responseText);
            if (d.error) { reject(new Error(d.error.message)); return; }
            const text = d.choices?.[0]?.message?.content || '';
            if (!text) { reject(new Error('Resposta OpenAI search vazia')); return; }
            resolve(text.trim());
          } catch (e) { reject(new Error('Erro OpenAI search: ' + e.message)); }
        },
        onerror() { reject(new Error('Erro rede (OpenAI search)')); },
        ontimeout() { reject(new Error('Timeout OpenAI search')); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // OUTBOUNDPRO
  // ═══════════════════════════════════════════════════════════════
  function callOutboundPro(endpoint, token, params = {}, method = 'GET') {
    return new Promise((resolve) => {
      let url = `https://app.outboundpro.com.br/api${endpoint}`;
      if (method === 'GET' && Object.keys(params).length > 0) {
        const query = new URLSearchParams(params).toString();
        url += '?' + query;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers: { 'Token': token, 'Content-Type': 'application/json' },
        data: method !== 'GET' ? JSON.stringify(params) : undefined,
        timeout: 10000,
        onload(res) {
          try {
            if (res.status >= 400) { resolve(null); return; }
            const data = JSON.parse(res.responseText);
            if (data.response === 'error') { resolve(null); return; }
            resolve(data);
          } catch (e) { resolve(null); }
        },
        onerror() { resolve(null); },
        ontimeout() { resolve(null); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // BRASIL API
  // ═══════════════════════════════════════════════════════════════
  function callBrasilAPI(cnpj) {
    const clean = String(cnpj || '').replace(/[.\/\-\s]/g, '');
    if (clean.length !== 14) return Promise.resolve(null);
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://brasilapi.com.br/api/cnpj/v1/${clean}`,
        timeout: 8000,
        onload(res) {
          try {
            if (res.status >= 400) { resolve(null); return; }
            resolve(JSON.parse(res.responseText));
          } catch (e) { resolve(null); }
        },
        onerror() { resolve(null); },
        ontimeout() { resolve(null); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // BUSCA POR CONTATO (Gemini → fallback OpenAI)
  // ═══════════════════════════════════════════════════════════════
  async function searchByContact(extracted, geminiKey, openaiKey) {
    if (!extracted.nomeContato) return { found: false, source: null, raw: null };

    const contato = extracted.nomeContato;
    const empresa = extracted.nomeEmpresa || '(não informada)';
    const cidade = extracted.cidade || '';
    const estado = extracted.estado || '';
    const localCtx = [cidade, estado].filter(Boolean).join('/');
    const cargo = extracted.cargo || '(não informado)';

    const userContent = `Investigue este lead B2B brasileiro para descobrir o decisor real.

DADOS DO LEAD:
• Nome do contato: ${contato}
• Empresa declarada: ${empresa}
• Cargo declarado: ${cargo}
• Localização declarada: ${localCtx || '(não informada)'}
• DDD do telefone: ${extracted.ddd || '?'}

INVESTIGUE NO GOOGLE (use Google Search):

1. BUSCAR LINKEDIN DO CONTATO:
   • "${contato}" linkedin
   • "${contato}" "${empresa}"
   • "${contato}" ${localCtx}
   → Confirma cargo? Empresa atual? Tempo no cargo?

2. BUSCAR SITE/INSTA DA EMPRESA:
   • "${empresa}" site oficial
   • "${empresa}" instagram
   • "${empresa}" ${localCtx}
   → Empresa real? Endereço bate?

3. BUSCAR NOTÍCIAS / MATÉRIAS:
   • "${contato}" "${empresa}" matéria OR entrevista
   • "${empresa}" notícia OR fundador
   → Tem menções públicas?

4. VERIFICAR SE É FRANQUIA:
   • Nomes como "AGF [bairro]" = Correios franqueada
   • Marcas conhecidas + bairro
   → Gerente Geral de franquia = decisor

5. CRUZAR EVIDÊNCIAS COM CETICISMO:
   • LinkedIn isolado pode ser homônimo
   • Sobrenome único elimina ambiguidade
   • Cargo precisa ser ATUAL na empresa específica

Responda APENAS JSON sem markdown:
{
  "linkedin_url": "URL do LinkedIn ou null",
  "cargo_confirmado": "cargo encontrado no LinkedIn ou null",
  "empresa_no_linkedin": "empresa do LinkedIn ou null",
  "empresa_bate_com_lead": true/false,
  "tempo_no_cargo": "ex: '2 anos' ou null",
  "outras_empresas": ["empresa1", "empresa2"] ou [],
  "site_empresa": "URL ou null",
  "instagram_empresa": "@handle ou null",
  "noticias_encontradas": "resumo ou null",
  "presenca_digital": "forte/média/fraca/inexistente",
  "is_franquia": true/false,
  "rede_franquia": "rede ou null",
  "match_confidence": "alta/média/baixa/sem_match",
  "evidencias_cruzamento": ["evidência 1", "evidência 2"] ou [],
  "alertas_ceticismo": ["alerta 1", "alerta 2"] ou [],
  "notes": "1-2 linhas com achado mais relevante"
}

REGRAS CRÍTICAS DE CETICISMO:
- Cargo declarado no formulário NÃO É PROVA
- Match parcial de nome (só primeiro nome) = baixa confiança
- LinkedIn sem confirmação de empresa = média
- LinkedIn + empresa + sobrenome único = alta
- Sempre liste alertas que vc identificar`;

    const systemPrompt = `Você é um investigador B2B cético. Use Google Search para descobrir o decisor real. Cruze evidências. Nunca confie em pista isolada. Retorne APENAS JSON válido.`;

    if (geminiKey) {
      try {
        const text = await callGemini(systemPrompt, userContent, geminiKey, 20000);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return { found: true, source: 'gemini', raw: JSON.parse(jsonMatch[0]) };
      } catch (e) { console.warn('Gemini falhou, caindo pra OpenAI:', e.message); }
    }

    if (openaiKey) {
      try {
        const text = await callOpenAISearch(systemPrompt, userContent, openaiKey, 25000);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return { found: true, source: 'openai_search', raw: JSON.parse(jsonMatch[0]) };
      } catch (e) { console.warn('OpenAI search também falhou:', e.message); }
    }

    return { found: false, source: null, raw: null };
  }

  // ═══════════════════════════════════════════════════════════════
  // BUSCA EMPRESA — OutboundPro primeiro, Brasil API fallback
  // ═══════════════════════════════════════════════════════════════
  async function searchCompany(extracted, outboundToken) {
    const results = { cnpj: null, source: null, empresa: null, contatos: [], contato_match: null, related_companies: [] };

    if (extracted.cnpjVisivel && extracted.cnpj) {
      const resp = await callOutboundPro('/company/prospect', outboundToken, { cnpj: extracted.cnpj.replace(/[^\d]/g, '') });
      if (resp?.date || resp?.data) {
        const empresa = resp.date || resp.data;
        results.cnpj = empresa.cnpj;
        results.source = 'OutboundPro (CNPJ direto)';
        results.empresa = empresa;
      }
    }

    if (!results.empresa && extracted.nomeEmpresa) {
      const searchParams = { nome_fantasia: extracted.nomeEmpresa };
      if (extracted.estado) searchParams.uf = extracted.estado;
      if (extracted.cidade && extracted.cidade !== 'Não informado') searchParams.cidade = extracted.cidade;

      const resp = await callOutboundPro('/lead/search', outboundToken, searchParams);
      if (resp?.leads?.length > 0) {
        let lead = resp.leads[0];
        if (extracted.cnpjParcial) {
          const matched = resp.leads.find(l => l.cnpj && l.cnpj.startsWith(extracted.cnpjParcial));
          if (matched) lead = matched;
        }
        const detailResp = await callOutboundPro('/lead/detail', outboundToken, { id: lead.id });
        if (detailResp?.empresa) {
          results.cnpj = detailResp.empresa.cnpj;
          results.source = 'OutboundPro (busca por nome empresa)';
          results.empresa = detailResp.empresa;
        } else {
          results.cnpj = lead.cnpj;
          results.source = 'OutboundPro (busca parcial)';
          results.empresa = lead;
        }
      } else {
        const resp2 = await callOutboundPro('/lead/search', outboundToken, {
          razao_social: extracted.nomeEmpresa,
          ...(extracted.estado && { uf: extracted.estado })
        });
        if (resp2?.leads?.length > 0) {
          const lead = resp2.leads[0];
          const detailResp = await callOutboundPro('/lead/detail', outboundToken, { id: lead.id });
          if (detailResp?.empresa) {
            results.cnpj = detailResp.empresa.cnpj;
            results.source = 'OutboundPro (busca por razão social)';
            results.empresa = detailResp.empresa;
          }
        }
      }
    }

    if (!results.empresa && extracted.cnpjVisivel && extracted.cnpj) {
      const brasilData = await callBrasilAPI(extracted.cnpj);
      if (brasilData) {
        results.cnpj = brasilData.cnpj;
        results.source = 'Brasil API (fallback)';
        results.empresa = brasilData;
      }
    }

    let matchType = 'nenhum';
    if (results.empresa && extracted.nomeContato) {
      const qsaList = results.empresa.contatos || results.empresa.qsa || [];
      const normNome = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const contatoBusca = normNome(extracted.nomeContato);
      const partesContato = contatoBusca.split(/\s+/).filter(p => p.length > 1);
      const primeiroNome = partesContato[0] || '';
      const ultimoNome = partesContato[partesContato.length - 1] || '';

      for (const socio of qsaList) {
        const nomeSocio = normNome(socio.nome || socio.nome_socio || '');
        const partesSocio = nomeSocio.split(/\s+/);
        const matches = partesContato.filter(p => partesSocio.includes(p)).length;
        if (matches >= 2 || nomeSocio === contatoBusca) { results.contato_match = socio; matchType = 'exato'; break; }
      }

      if (!results.contato_match) {
        for (const socio of qsaList) {
          const nomeSocio = normNome(socio.nome || socio.nome_socio || '');
          const partesSocio = nomeSocio.split(/\s+/);
          if (primeiroNome && partesSocio.includes(primeiroNome)) { results.contato_match = socio; matchType = 'parcial'; break; }
          if (ultimoNome && ultimoNome !== primeiroNome && partesSocio.includes(ultimoNome)) { results.contato_match = socio; matchType = 'parcial'; break; }
        }
      }
    }
    results.match_type = matchType;
    results.contato_lead = extracted.nomeContato;

    if (results.empresa?.id && results.contato_match?.id) {
      const contatoResp = await callOutboundPro('/contact/detail', outboundToken, { id: results.contato_match.id });
      if (contatoResp?.contact) {
        results.contato_match = { ...results.contato_match, ...contatoResp.contact };
        results.related_companies = contatoResp.contact.other_companies || [];
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  // MONTA CONTEXTO PARA O GPT
  // ═══════════════════════════════════════════════════════════════
  function buildContext(searchResults) {
    if (!searchResults.empresa) {
      return `BUSCA EXTERNA: Empresa não localizada no OutboundPro nem Brasil API.
Gate 1 falha → Veredito 🔴 NÃO COMPRAR.`;
    }

    const e = searchResults.empresa;
    const qsa = e.contatos || e.qsa || [];

    let ctx = `DADOS DA EMPRESA (${searchResults.source}):
CNPJ: ${e.cnpj || 'não informado'}
Razão Social: ${e.razao_social || '?'}
Nome Fantasia: ${e.nome_fantasia || '(sem)'}
Situação: ${e.situacao || e.descricao_situacao_cadastral || '?'}
Capital Social: ${e.capital_social ? 'R$ ' + Number(e.capital_social).toLocaleString('pt-BR') : '?'}
Porte: ${e.porte || e.descricao_porte || '?'}
Data Abertura: ${e.data_abertura || e.data_inicio_atividade || '?'}
CNAE: ${e.cnae_principal?.descricao_subclasse || e.cnae_fiscal_descricao || '?'}
Endereço: ${e.endereco || e.logradouro || ''}, ${e.endereco_cidade || e.municipio || ''}/${e.endereco_uf || e.uf || ''}
Email Receita: ${e.email_principal || e.email || '?'}
Telefone Receita: ${e.telefone_principal || ''} ${e.telefone_secundario || ''}`;

    if (qsa.length > 0) {
      ctx += `\n\nQSA COMPLETO (sócios oficiais — ${qsa.length} ${qsa.length === 1 ? 'sócio' : 'sócios'}):\n`;
      qsa.forEach(s => {
        const nome = s.nome || s.nome_socio;
        const qual = s.qualificacao || s.qualificacao_socio;
        ctx += `• ${nome} (${qual || 'sócio'})\n`;
      });
    }

    if (searchResults.contato_lead) {
      ctx += `\n\nCONTATO DECLARADO NO LEAD: "${searchResults.contato_lead}"`;
    }

    if (searchResults.contato_match) {
      const m = searchResults.contato_match;
      const matchType = searchResults.match_type;

      if (matchType === 'exato') {
        ctx += `\n\n✅ DECISOR CONFIRMADO (match exato no QSA):
Nome no QSA: ${m.nome || m.nome_socio}
Qualificação: ${m.qualificacao || m.qualificacao_socio}
Data de entrada: ${m.data_entrada_sociedade || '?'}
Faixa etária: ${m.age_range || m.faixa_etaria || '?'}`;
      } else if (matchType === 'parcial') {
        ctx += `\n\n⚠️ POSSÍVEL MATCH (parcial — LDR deve confirmar visualmente):
Sócio sugerido: ${m.nome || m.nome_socio}
Qualificação: ${m.qualificacao || m.qualificacao_socio}
ATENÇÃO: o nome do contato no lead está incompleto/abreviado.
GPT NÃO confirma sozinho — LDR olha o QSA acima e decide.
Aplique status ⚠️ POSSÍVEL MATCH → score teto 65/100 → 🟡`;
      }

      if (m.linkedin) ctx += `\nLinkedIn: ${m.linkedin}`;
      if (m.facebook) ctx += `\nFacebook: ${m.facebook}`;
      if (m.instagram) ctx += `\nInstagram: ${m.instagram}`;

      if (m.phones?.length > 0) {
        ctx += `\nTelefones validados:`;
        m.phones.forEach(p => { ctx += `\n  • ${p.number} (${p.type}${p.whatsapp ? ', WHATSAPP' : ''}${p.valid ? ', válido' : ''})`; });
      } else if (m.telefones?.length > 0) {
        ctx += `\nTelefones:`;
        m.telefones.forEach(p => { ctx += `\n  • ${p.numero} (${p.tipo}${p.whatsapp ? ', WHATSAPP' : ''})`; });
      }

      if (m.emails?.length > 0) {
        ctx += `\nEmails validados:`;
        m.emails.forEach(em => { ctx += `\n  • ${em.email}${em.valid ? ' (válido)' : ''}`; });
      }

      if (m.inferred_email?.inferred_email) {
        ctx += `\nEmail inferido: ${m.inferred_email.inferred_email} (score ${m.inferred_email.score})`;
      }
    } else {
      if (qsa.length > 0) {
        ctx += `\n\n❌ DECISOR NÃO IDENTIFICADO NO QSA:
O nome "${searchResults.contato_lead || '?'}" não bate com nenhum dos sócios listados acima.
LDR pode verificar visualmente o QSA completo (acima) para ter certeza.
Cargo declarado no formulário NÃO conta como prova.
Gate 2 = NÃO VALIDADO → score máximo 40/100.`;
      } else {
        ctx += `\n\n❌ EMPRESA SEM QSA DISPONÍVEL:
Não há lista de sócios para validar o contato.
Gate 2 = NÃO VALIDADO → score máximo 40/100.`;
      }
    }

    if (searchResults.related_companies?.length > 0) {
      ctx += `\n\nOUTRAS EMPRESAS DO SÓCIO (WTP):\n`;
      searchResults.related_companies.forEach(rc => {
        ctx += `• ${rc.trade_name || rc.company_name} — ${rc.city || ''}/${rc.state || ''} (${rc.status || ''})\n`;
      });
      ctx += `Total: ${searchResults.related_companies.length} empresas vinculadas → empreendedor com patrimônio.`;
    }

    return ctx;
  }

  // ═══════════════════════════════════════════════════════════════
  // FLUXO PRINCIPAL
  // ═══════════════════════════════════════════════════════════════
  async function analyze(leadText, mode) {
    const openaiKey = getOpenAIKey();
    if (!openaiKey) return;
    const outboundToken = getOutboundProToken();
    if (!outboundToken) return;

    const myRun = ++v4RunId;
    const isCurrent = () => myRun === v4RunId;

    fab.disabled = true;
    openPanel();
    resetAnalysisUI();
    v4RefreshHealth();

    const extracted = preExtract(leadText);
    if (!isCurrent()) return;
    v4CurrentLead = { empresa: extracted.nomeEmpresa, contato: extracted.nomeContato };
    renderLeadTag(extracted);

    const cached = getCached(leadText, mode);
    if (cached) {
      if (isCurrent()) {
        renderResult(cached, true);
        fab.disabled = false;
        fab.innerHTML = '<span style="font-size:14px">🔴</span><span>Analisar Lead</span>';
      }
      return;
    }

    const instantSignal = computeLocalDecision(extracted, leadText);
    if (!isCurrent()) return;
    renderInstant(instantSignal, extracted);
    v4StartWindow(10);

    try {
      let geminiKey = GM_getValue('v4_gemini_key', '') || null;
      const askedGemini = GM_getValue('v4_gemini_asked', false);

      if (!geminiKey && !askedGemini) {
        GM_setValue('v4_gemini_asked', true);
        const want = confirm(
          '🔍 Quer melhorar a busca com Gemini + Google Search?\n\n' +
          '✅ Busca de LinkedIn/Insta/notícias muito mais assertiva\n' +
          '✅ Pesquisa com Google nativo (qualidade superior)\n' +
          '⚠️ Precisa de chave Gemini com billing ativado\n' +
          '   em aistudio.google.com/apikey\n\n' +
          'OK = configurar agora\n' +
          'Cancelar = usar OpenAI Search (fallback)\n\n' +
          '(Pode configurar depois clicando em ⚙ API Keys)'
        );
        if (want) geminiKey = getGeminiKey();
      }

      updateStep(2, 'active', geminiKey
        ? 'Busca paralela: OutboundPro + Gemini (Google Search)'
        : 'Busca paralela: OutboundPro + OpenAI Search');

      const [searchResults, contactSearch] = await Promise.all([
        searchCompany(extracted, outboundToken),
        searchByContact(extracted, geminiKey, openaiKey)
      ]);
      if (!isCurrent()) return;

      const fonteBusca = contactSearch.source === 'gemini' ? '🔍 Gemini' :
                         contactSearch.source === 'openai_search' ? '🔍 OpenAI' : '⚠️ sem busca';
      if (searchResults.empresa) {
        updateStep(2, 'done', `Empresa: ${searchResults.source} · Contato: ${fonteBusca}`);
      } else if (contactSearch.found) {
        updateStep(2, 'done', `Empresa não localizada · Contato: ${fonteBusca}`);
      } else {
        updateStep(2, 'done', 'Empresa e contato não localizados');
      }

      updateStep(3, 'active', 'Consolidando dados...');
      let context = buildContext(searchResults);

      if (contactSearch.found && contactSearch.raw) {
        const inv = contactSearch.raw;
        context += `\n\n═══════════════════════════════════════════════════
INVESTIGAÇÃO WEB DO CONTATO (via ${contactSearch.source === 'gemini' ? 'Gemini Google Search' : 'OpenAI Search'}):
═══════════════════════════════════════════════════
`;
        if (inv.linkedin_url) context += `\nLinkedIn: ${inv.linkedin_url}`;
        if (inv.cargo_confirmado) context += `\nCargo confirmado no LinkedIn: ${inv.cargo_confirmado}`;
        if (inv.empresa_no_linkedin) context += `\nEmpresa no LinkedIn: ${inv.empresa_no_linkedin}`;
        if (inv.empresa_bate_com_lead !== undefined) {
          context += `\nEmpresa do LinkedIn bate com lead: ${inv.empresa_bate_com_lead ? 'SIM' : 'NÃO'}`;
        }
        if (inv.tempo_no_cargo) context += `\nTempo no cargo: ${inv.tempo_no_cargo}`;
        if (inv.outras_empresas?.length > 0) context += `\nOutras empresas do contato: ${inv.outras_empresas.join(', ')}`;
        if (inv.site_empresa) context += `\nSite oficial: ${inv.site_empresa}`;
        if (inv.instagram_empresa) context += `\nInstagram: ${inv.instagram_empresa}`;
        if (inv.noticias_encontradas) context += `\nNotícias/matérias: ${inv.noticias_encontradas}`;
        if (inv.presenca_digital) context += `\nPresença digital: ${inv.presenca_digital}`;
        if (inv.is_franquia) {
          context += `\n🏪 É FRANQUIA: ${inv.rede_franquia || 'rede não identificada'}`;
          context += `\n   → Gerente Geral de franquia É DECISOR (qualquer tier)`;
        }
        if (inv.match_confidence) context += `\n\nCONFIANÇA DO MATCH: ${inv.match_confidence.toUpperCase()}`;
        if (inv.evidencias_cruzamento?.length > 0) {
          context += `\nEvidências cruzadas:`;
          inv.evidencias_cruzamento.forEach(ev => context += `\n  • ${ev}`);
        }
        if (inv.alertas_ceticismo?.length > 0) {
          context += `\n\n⚠️ ALERTAS DE CETICISMO:`;
          inv.alertas_ceticismo.forEach(a => context += `\n  ⚠️ ${a}`);
        }
        if (inv.notes) context += `\n\nAchado relevante: ${inv.notes}`;
      } else if (!contactSearch.found && extracted.nomeContato) {
        context += `\n\n⚠️ INVESTIGAÇÃO WEB DO CONTATO: nenhum resultado encontrado.
Nem Gemini nem OpenAI Search localizaram o contato em LinkedIn/sites/notícias.
→ Gate 2 fica como NÃO VALIDADO`;
      }

      updateStep(3, 'done');

      updateStep(4, 'active', 'Análise final com gpt-4o + cruzamento cético');
      const result = await callOpenAI(
        ANALYSIS_PROMPT,
        `DADOS DO LEAD (LeadBroker):\n${leadText}\n\n---\n\n${context}`,
        openaiKey,
        25000
      );
      if (!isCurrent()) return;

      updateStep(4, 'done');

      const provenance = buildProvenance(extracted, searchResults, contactSearch);
      const finalText = provenance + result;
      setCache(leadText, mode, finalText);
      if (isCurrent()) renderResult(finalText, false);

    } catch (err) {
      if (isCurrent()) renderError(err.message);
    } finally {
      if (isCurrent()) {
        fab.disabled = false;
        fab.innerHTML = '<span style="font-size:14px">🔴</span><span>Analisar Lead</span>';
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════════
  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.v4-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    modeHint.textContent = mode === 'garimpo'
      ? 'Garimpo: 8-10s · investigação profunda + WTP do sócio'
      : 'Express: 4-6s · busca OutboundPro + análise';
  }

  document.querySelectorAll('.v4-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  fab.addEventListener('click', async () => {
    // run-token protege contra sobreposição — pode trocar de lead mesmo processando
    let text = window.getSelection().toString().trim();
    if (!text) {
      text = prompt('Cole os dados do lead aqui:');
      if (!text) return;
    }
    const ex = preExtract(text);
    if (ex.isNoturno && currentMode === 'express') setMode('garimpo');
    await analyze(text, currentMode);
  });

  document.getElementById('v4-close').addEventListener('click', closePanel);

  document.getElementById('v4-key').addEventListener('click', () => {
    if (confirm('Remover TODAS as chaves (OpenAI, Gemini, OutboundPro) e configurar novas?')) {
      GM_setValue('v4_openai_key', '');
      GM_setValue('v4_gemini_key', '');
      GM_setValue('v4_outbound_token', '');
      GM_setValue('v4_gemini_asked', false);
      v4Health = null;
      alert('Chaves removidas. Configure novamente na próxima análise.');
      closePanel();
    }
  });

  document.getElementById('v4-clear-cache').addEventListener('click', () => {
    if (confirm('Limpar todos os leads em cache?')) {
      clearAllCache();
      alert('Cache limpo.');
    }
  });

  document.getElementById('v4-new').addEventListener('click', () => {
    closePanel();
    setTimeout(() => {
      const text = prompt('Cole os dados do lead:');
      if (text?.trim()) analyze(text.trim(), currentMode);
    }, 200);
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // checa integrações já na carga (sem abrir o painel)
  setTimeout(() => { v4RefreshHealth(true); }, 1500);

})();
