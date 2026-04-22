# Modelagem Firestore — Mínima (3 collections)

## Estrutura

```
/jobs/{jobId}
/payloads/{payloadId}
/logs/{logId}
```

---

## Collection: `jobs`

Um documento por importação (upload de planilha).

| Campo | Tipo | Exemplo |
|-------|------|---------|
| `status` | `string` | `pending` \| `running` \| `paused` \| `completed` |
| `total` | `number` | `11000` |
| `progress` | `number` | `3420` |
| `closeExisting` | `boolean` | `false` |
| `fileName` | `string` | `"VLI_Abril_2024.xlsx"` |
| `createdAt` | `timestamp` | — |
| `updatedAt` | `timestamp` | — |

```json
{
  "status": "paused",
  "total": 11000,
  "progress": 3420,
  "closeExisting": false,
  "fileName": "VLI_Abril_2024.xlsx",
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

## Collection: `payloads`

**Um documento por linha da planilha.** Status `pending` → processado → `sent` ou `error`.
Ao retomar um job, busca só os `pending` daquele `jobId`.

| Campo | Tipo | Exemplo |
|-------|------|---------|
| `jobId` | `string` | `"abc123"` |
| `rowIndex` | `number` | `0` (para ordenar) |
| `reference` | `string` | `"CE-3020-ED02"` |
| `locationId` | `string` | `"6203"` |
| `fields` | `map` | `{ "9143": "PREDIO ALMOX", "9144": "VLI Multimodal" }` |
| `status` | `string` | `pending` \| `sent` \| `error` |
| `errorMessage` | `string` | `null` ou mensagem |
| `sentAt` | `timestamp` | `null` ou quando foi enviado |
| `createdAt` | `timestamp` | — |

```json
{
  "jobId": "abc123",
  "rowIndex": 0,
  "reference": "CE-3020-ED02",
  "locationId": "6203",
  "fields": {
    "9143": "PREDIO ALMOXARIFADO - AMRO",
    "9144": "VLI Multimodal",
    "9145": "PCEM",
    "9146": "CE-3020",
    "9147": "ARMAZENAMENTO INTERNO",
    "9148": "PECEM",
    "9149": "CN",
    "9150": "São Gonçalo do Amarante - CE"
  },
  "status": "pending",
  "errorMessage": null,
  "sentAt": null,
  "createdAt": "..."
}
```

> `fields` é um `map` de `{ field_id → value }` — comporta até 20 colunas tranquilamente.
> O admin configura quais IDs mapear para cada coluna no painel `/admin`.

---

## Collection: `logs`

Logs de execução vinculados a um job.

| Campo | Tipo | Exemplo |
|-------|------|---------|
| `jobId` | `string` | `"abc123"` |
| `type` | `string` | `info` \| `success` \| `error` |
| `message` | `string` | `"[42/11000] Enviado: CE-3020-ED02"` |
| `timestamp` | `timestamp` | — |

```json
{
  "jobId": "abc123",
  "type": "error",
  "message": "[42/11000] Falha ao enviar CE-3020-ED02: 422",
  "timestamp": "..."
}
```

---

## Índices compostos necessários

```json
[
  {
    "collection": "payloads",
    "fields": ["jobId ASC", "status ASC", "rowIndex ASC"]
  },
  {
    "collection": "logs",
    "fields": ["jobId ASC", "timestamp DESC"]
  }
]
```

---

## Retomada de job (lógica de resume)

```typescript
// Busca só os payloads pendentes do job, em ordem
const pending = await db.collection('payloads')
  .where('jobId', '==', jobId)
  .where('status', '==', 'pending')
  .orderBy('rowIndex')
  .get();

// Processa cada um e atualiza o status
await payloadRef.update({
  status: 'sent',       // ou 'error'
  sentAt: serverTimestamp(),
  errorMessage: null    // ou a mensagem de erro
});
```
