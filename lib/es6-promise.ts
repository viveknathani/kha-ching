import { OrderInformation } from 'inves-broker'

export interface allSettledInterface {
  status: string
  value: {
    successful: boolean
    response: OrderInformation
  }
}

export const allSettled = async promises => Promise.allSettled(promises)
