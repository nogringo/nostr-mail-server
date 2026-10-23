import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { normalizeDomain } from '../domain.js'
import type { AbuseReader, AbuseReport, Domain, DomainRepository } from '../types.js'
import { authenticate, authenticateAdmin } from './auth.js'

type ReportRequest = FastifyRequest<{ Params: { id: string } }>
type DomainReportRequest = FastifyRequest<{ Params: { domain: string; id: string } }>

// Postgres integers.
const MAX_ID = 2 ** 31 - 1

// The messages sent to abuse@, as received: the admins read every domain's, the
// owner of a domain those that came since its claim owns it. Each deletes a
// report for itself, the others keep it.
export function registerAbuseRoutes(app: FastifyInstance, repo: DomainRepository, admins: string[]): void {
  app.get('/admin/abuse-reports/:id', async (request: ReportRequest, reply) => {
    if (authenticateAdmin(request, reply, admins) === null) return reply

    const id = parseId(request.params.id)
    const message = id ? await repo.findAbuseMessage(id, 'admin') : null
    if (!message) return reply.code(404).send({ error: 'abuse_report_not_found' })

    return sendMessage(reply, message)
  })

  app.delete('/admin/abuse-reports/:id', async (request: ReportRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const id = parseId(request.params.id)
    if (!id || !(await repo.deleteAbuseReport(id, 'admin'))) {
      return reply.code(404).send({ error: 'abuse_report_not_found' })
    }

    request.log.info({ id, admin }, 'An admin deleted an abuse report')
    return reply.code(204).send()
  })

  app.get('/domains/:domain/abuse-reports/:id', async (request: DomainReportRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    const domain = name ? await repo.findDomain(name, pubkey) : null
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    const id = parseId(request.params.id)
    const reader = ownerOf(domain)
    const message = id && reader ? await repo.findAbuseMessage(id, reader) : null
    if (!message) return reply.code(404).send({ error: 'abuse_report_not_found' })

    return sendMessage(reply, message)
  })

  app.delete('/domains/:domain/abuse-reports/:id', async (request: DomainReportRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    const domain = name ? await repo.findDomain(name, pubkey) : null
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    const id = parseId(request.params.id)
    const reader = ownerOf(domain)
    if (!id || !reader || !(await repo.deleteAbuseReport(id, reader))) {
      return reply.code(404).send({ error: 'abuse_report_not_found' })
    }

    request.log.info({ id, domain: domain.domain }, 'The owner of a domain deleted an abuse report')
    return reply.code(204).send()
  })
}

export async function listOwnReports(repo: DomainRepository, domain: Domain): Promise<AbuseReport[]> {
  const reader = ownerOf(domain)
  return reader ? repo.listAbuseReports(reader) : []
}

// A key that takes a domain over does not read what was reported to the previous owner.
function ownerOf(domain: Domain): AbuseReader | null {
  return domain.verifiedAt ? { domain: domain.domain, since: domain.verifiedAt } : null
}

function parseId(value: string): number | null {
  const id = Number(value)
  return /^\d+$/.test(value) && id >= 1 && id <= MAX_ID ? id : null
}

function sendMessage(reply: FastifyReply, message: Buffer) {
  return reply.type('message/rfc822').send(message)
}
