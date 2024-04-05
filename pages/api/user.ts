import { KiteConnect } from 'kiteconnect'

import withSession from '../../lib/session'
import { SignalXUser } from '../../types/misc'

const apiKey = process.env.KITE_API_KEY

export default withSession(async (req, res) => {
  const user: SignalXUser = req.session.get('user')

  console.log('user', user)

  if (user) {
    const kc = new KiteConnect({
      api_key: apiKey,
      access_token: user?.session?.access_token
    })

    console.log("kc done");

    try {
      // see if we're able to fetch profile with the access token
      // in case access token is expired, then log out the user
      await kc.getProfile()

      console.log("profile fetch done");

      res.json({
        ...user,
        isLoggedIn: true
      })
    } catch (e) {
      req.session.destroy()
      res.json({
        isLoggedIn: false
      })
    }
  } else {
    console.log('else condn')
    res.json({
      isLoggedIn: false
    })
  }
})
