import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { normalizeDomain } from '../domain.js'
import type { AbuseReport, Domain, DomainRepository } from '../types.js'
import { authenticate, authenticateAdmin } from './auth.js'

type ReportRequest = FastifyRequest<{ Params: { id: string } }>
type DomainReportRequest = FastifyRequest<{ Params: { domain: string; id: string } }>

// Postgres integers.
const MAX_ID = 2 ** 31 - 1

// The messages sent to abuse@, as received: the admins read every domain's,
// the owner of a domain those that came since its claim owns it.
export function registerAbuseRoutes(app: FastifyInstance, repo: DomainRepository, admins: string[]): void {
  app.get('/admin/abuse-reports/:id', async (request: ReportRequest, reply) => {
    if (authenticateAdmin(request, reply, admins) === null) return reply

    const id = parseId(request.params.id)
    const found = id ? await repo.findAbuseReport(id) : null
    if (!found) return reply.code(404).send({ error: 'abuse_report_not_found' })

    return sendMessage(reply, found.message)
  })

  app.get('/domains/:domain/abuse-reports/:id', async (request: DomainReportRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    const domain = name ? await repo.findDomain(name, pubkey) : null
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    const id = parseId(request.params.id)
    const found = id ? await repo.findAbuseReport(id) : null
    if (!found || !isOwnReport(domain, found.report)) return reply.code(404).send({ error: 'abuse_report_not_found' })

    return sendMessage(reply, found.message)
  })
}

export async function listOwnReports(repo: DomainRepository, domain: Domain): Promise<AbuseReport[]> {
  return domain.verifiedAt ? repo.listAbuseReports({ domain: domain.domain, since: domain.verifiedAt }) : []
}

// A key that takes a domain over does not read what was reported to the previous owner.
function isOwnReport(domain: Domain, report: AbuseReport): boolean {
  return domain.verifiedAt !== null && report.domain === domain.domain && report.receivedAt >= domain.verifiedAt
}

function parseId(value: string): number | null {
  const id = Number(value)
  return /^\d+$/.test(value) && id >= 1 && id <= MAX_ID ? id : null
}

function sendMessage(reply: FastifyReply, message: Buffer) {
  return reply.type('message/rfc822').send(message)
}
