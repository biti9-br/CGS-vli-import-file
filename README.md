# VLI → Cargosnap Importer Automation

Este projeto é uma automação web desenvolvida para substituir e aprimorar o script original de importação de dados da VLI para a plataforma Cargosnap.

## Funcionalidades

1. **Upload de Arquivos**: Suporte para planilhas Excel (`.xlsx`, `.xls`) e arquivos `.csv`.
2. **Mapeamento (De-Para)**: Interface visual para mapear as colunas do arquivo original para os IDs correspondentes no Cargosnap.
3. **Desduplicação**: Seleção da coluna `Reference` para garantir que registros duplicados sejam tratados (mantendo o último registro).
4. **Correção de Parser (RFC 4180)**: Geração de CSV utilizando a biblioteca `PapaParse`, que corrige o bug do script original ao tratar aspas duplas internas (ex: endereços).
5. **Simulador de Importação**: 
   - Validação de formato do Token da API.
   - Controle de `delay` configurável (originalmente fixo em 500ms).
   - Flag `closeExisting` configurável.
   - **Persistência de Sessão**: Se a página for recarregada ou fechada acidentalmente, a importação pode ser retomada exatamente de onde parou (usando `localStorage`).
   - Console visual com logs em tempo real e barra de progresso.
6. **Histórico de Importações**: Aba lateral retrátil que armazena o histórico das importações realizadas, com status, data e quantidade de registros processados.

## Como Usar

1. Acesse a aplicação.
2. No Passo 1, faça o upload da planilha com os dados de equipamentos ou locais de instalação.
3. No Passo 2, selecione qual coluna representa o `Reference` e preencha os IDs do Cargosnap para as demais colunas.
4. Clique em "Processar e Desduplicar".
5. No Passo 3, você pode baixar o CSV corrigido e formatado, ou prosseguir para o simulador.
6. No Passo 4, insira o Token da API, ajuste o delay e inicie a simulação de importação.

## Requisitos Técnicos

- Node.js (v18 ou superior recomendado)
- npm (gerenciador de pacotes do Node.js)
- React 19
- Tailwind CSS 4
- Bibliotecas principais: `xlsx` (SheetJS), `papaparse`, `lucide-react`

## Como Rodar Localmente

Siga o passo a passo abaixo para rodar o projeto na sua máquina:

1. **Clone o Repositório**:
   ```bash
   git clone <sua-url-do-repositorio>
   cd CGS-vli-import-file
   ```

2. **Instale as Dependências**:
   Este é um projeto Node.js e utiliza o `npm` para gerenciar pacotes. Execute o comando abaixo para baixar tudo o que foi listado no `package.json` (você pode verificar os pacotes também no `requirements.txt` gerado):
   ```bash
   npm install
   ```

3. **Configuração de Variáveis de Ambiente**:
   Crie um arquivo `.env` com base no arquivo de exemplo existente:
   ```bash
   cp .env.example .env
   ```
   *Certifique-se de preencher as chaves de API e outras configurações no `.env`.*

4. **Inicie o Servidor de Desenvolvimento**:
   Para iniciar a aplicação frontend e as rotas associadas, digite:
   ```bash
   npm run dev
   ```

5. **Acesso via Navegador**:
   Acesse no seu navegador a URL informada pelo terminal, geralmente: `http://localhost:5173/`

## LGPD e Segurança

- **Nenhum dado sensível é persistido** no servidor. Todo o processamento de planilhas e geração de CSV ocorre localmente no navegador do usuário (Client-side).
- O Token da API inserido no simulador é mantido apenas em memória durante a sessão ativa.
