/*!
 * Copyright (c) 2015-2016, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 */

/* eslint no-param-reassign:0 no-console:0, brace-style:0 */

'use strict';

const url = require('url');
const Table = require('cli-table2');
const chalk = require('chalk');
const diff = require('diff');
const debug = require('debug')('mock-okta');
const querystring = require('querystring');
const jws = require('jws');
const keys = require('./keys-test');
const tokenHash = require('oidc-token-hash');

const util = module.exports;

// ----------------------------------------------------------------------------
// Logger helper functions

/**
 * Helper function which formats long strings into multiple lines of the
 * specified width
 * @arg {string} str - the string to format
 * @arg {number} width - the number of characters before wrapping
 */
function wrap(str, width) {
  const wrapped = [];
  const mbChars = str.match(/(?:(?:\u001b\[[0-9;]*m)*.?){1}/g);
  mbChars.forEach((char, i) => {
    if (i !== 0 && i % width === 0) {
      wrapped.push('\n');
    }
    wrapped.push(char);
  });
  return wrapped.join('');
}

/**
 * Helper function which converts a value to a diff-able string
 * @arg val - the value to convert
 */
function toString(val) {
  if (Array.isArray(val)) {
    return val.join(' , ');
  }
  if (typeof val === 'number') {
    return Number(val).toString();
  }
  if (typeof val === 'boolean') {
    return val.toString();
  }
  return val || '';
}

/**
 * Displays a table with inline diffs between two given objects
 * @arg {string} title - a title to show above the table
 * @arg {object} before - the object that is being compared
 * @arg {object} after - the transformed object
 */
function logDiff(title, before, after) {
  /* istanbul ignore next */
  const cols = process.stdout.columns || 100;
  const keyWidth = 25;
  const valWidth = cols - keyWidth - 5;
  const table = new Table({ colWidths: [keyWidth, valWidth] });

  // Find diffs for the keys that exist in the before object
  Object.keys(before).forEach((key) => {
    const charDiff = diff.diffChars(
      toString(before[key]),
      toString(after[key])
    );
    const val = charDiff.map((part) => {
      if (part.added) {
        return chalk.green(part.value);
      } else if (part.removed) {
        return chalk.red(part.value);
      }
      return part.value;
    });
    table.push([wrap(key, keyWidth - 2), wrap(val.join(''), valWidth - 2)]);
  });

  // Add new keys that are added in the after object
  Object.keys(after).forEach((key) => {
    if (before[key]) {
      return;
    }
    table.push([
      wrap(key, keyWidth - 2),
      wrap(chalk.green(after[key]), valWidth - 2),
    ]);
  });

  debug(`${chalk.bold(title)}\n${table.toString()}\n`);
}

// ----------------------------------------------------------------------------
// Transform: Incoming request

/**
 * Parses query parameters out of the url
 * @arg {string} urlStr
 */
util.parseQuery = (urlStr) => {
  const parsed = url.parse(urlStr);
  return querystring.parse(parsed.query);
};

/**
 * Modifies the incoming request to map to one of our pre-recorded tapes. The
 * caching algorithm from request -> tape is very strict - we must remove any
 * values that can change between requests, browsers, or browser state.
 *
 * @arg {http.IncomingMessage} req
 * @arg record {boolean} - flag to indicate if mock server is running in record mode
 * @return {object} data that is needed to reconstruct state in the response
 */
util.mapRequestToCache = (req, record) => {
  const headers = req.headers;
  const orig = Object.assign({}, headers);
  const data = {};
  const isPreflight = !!headers['access-control-request-method'];

  // Delete headers that might differ between browsers and browser state
  delete headers['upgrade-insecure-requests'];
  delete headers['x-okta-user-agent-extended'];
  delete headers['if-none-match'];
  delete headers['if-modified-since'];
  delete headers.expect;
  delete headers.referer;

  // Enforce a consistent userAgent to prevent differences returned from
  // the server (i.e. lo-fi flows)
  headers['user-agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; ' +
    'rv:48.0) Gecko/20100101 Firefox/48.0';

  // Due to the differences in back-ends while calling the /.well-known endpoint,
  // we force the connection to 'keep-alive'
  headers.connection = 'keep-alive'; 

  // Enforce a consistent accept-language and encoding
  headers['accept-language'] = 'en-US';
  headers['accept-encoding'] = 'gzip';

  // Enforce a consistent accept for html responses
  /* istanbul ignore next */
  if (headers.accept) {
    if (headers.accept.indexOf('text/html') > -1) {
      headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    } else if (headers.accept.indexOf('json') > -1) {
      headers.accept = 'application/json';
    } else {
      headers.accept = '*/*';
    }
  }

  // Enforce 'application/json' on api requests - PhantomJs does not send a
  // contentType on DELETE requests
  if (!isPreflight && req.url.indexOf('/api/v1') > -1) {
    headers['content-type'] = 'application/json';
  }

  if (isPreflight) {
    // Chrome does not send the content-length header on empty pre-flight requests
    if (headers['content-length'] === '0') {
      delete headers['content-length'];
    }

    // Browsers vary on which access-control-request headers they send, and the
    // ordering.
    headers['access-control-request-headers'] = headers['access-control-request-headers']
      .split(',')
      .map(header => header.trim())
      .filter(header => ['accept', 'origin'].indexOf(header) === -1)
      .sort()
      .join(', ');
  }

  // Remove cookies that update values on every request
  headers.cookie = headers.cookie || '';
  headers.cookie = headers.cookie.replace(/ADRUM[^;]+(;|$)\s*/gi, '');

  // Turn off caching so we always request resources when recording
  headers['cache-control'] = 'no-cache, no-store';
  headers.pragma = 'no-cache';

  // For the authorize flows, map the state and nonce values to known values,
  // and then restore them when constructing the response
  if (req.url.indexOf('authorize?') > -1) {
    const query = util.parseQuery(req.url);
    data.isAuthorizeReq = true;
    data.responseMode = query.response_mode;
    data.state = query.state;
    data.nonce = query.nonce;
    
    // Replace the state and nonce with known values.
    // Ensure that scope query parameter is the same for all requests (same as recorded)
    req.url = req.url
      .replace(`state=${query.state}`, 'state=STATE')
      .replace(`nonce=${query.nonce}`, 'nonce=NONCE')
      .replace('profile%20email%20openid', 'openid%20profile%20email');

    // Start the flow with fresh cookies
    data.cookie = headers.cookie;
    delete headers.cookie;
  }

  // If we hit primaryAuth first, let's delete the cookies here
  else if (req.url === '/api/v1/authn') {
    data.cookie = headers.cookie;
    delete headers.cookie;
  }

  // When we kill the session, store the incoming cookies to delete them
  // in the response headers
  else if (req.url.indexOf('/sessions/me') > -1 && req.method === 'DELETE') {
    data.cookie = headers.cookie;
  }

  // We are redirecting to the client callback. We need to replace the state query parameter with
  // the state stored in the tape before the redirect
  else if (req.url.indexOf('/oauth2/v1/authorize/redirect') === 0) {
    data.isRedirectCallback = true;
  }

  else if (req.url.indexOf('/oauth2/default/v1/token') === 0) {
    data.isTokenReq = true;
  }   

  // Refer to this wiki to understand why we do this - https://oktawiki.atlassian.net/wiki/spaces/PM/pages/242104529/Mock+Server+for+samples
  // Gist: /userinfo endpoint tape expects the same access_token that was used during recording
  // Since we now sign the access_token in our mock-server, we need to replace it with the original access_token
  else if (!record && req.url.indexOf('/oauth2/default/v1/userinfo') >= 0) {
    headers['authorization'] = 'Bearer ' + keys.accessToken;
  }

  logDiff('Mapping incoming request headers to cache', orig, headers);
  return data;
};

// ----------------------------------------------------------------------------
// Transform: Outgoing response

/**
 * Replaces any proxied server urls, including cdn urls when it is active, with
 * the proxy url.
 *
 * @arg {string} str - string to replace urls over
 * @arg {object} data
 * @arg {string} data.proxied - url
 * @arg {string} data.cdn - url
 * @arg {string} data.proxy - url
 * @return {string}
 */
function replaceUrls(str, data) {
  const proxied = url.parse(data.proxied);

  // This handles the normal case as well as the escaped case:
  // normal: http://rain.okta1.com:1802
  // escaped: http\x3A\x2F\x2Frain.okta1.com\x3A1802
  let escapes = `${proxied.protocol.slice(0, -1)}.{3,12}${proxied.hostname}`;
  if (proxied.port) {
    escapes += `.{1,4}${proxied.port}`;
  }

  const patterns = [escapes, `(https:)?//${url.parse(data.cdn).host}`];
  return patterns
    .map(pattern => new RegExp(pattern, 'g'))
    .reduce((memo, p) => memo.replace(p, data.proxy), str);
}

/**
 * Swaps the cached id_token with a new id_token that has a valid nonce, issuer,
 * and expiration time.
 *
 * @arg {string} idToken
 * @arg {object} data
 * @arg {string} data.nonce
 * @arg {string} data.iss
 */
function swapIdToken(idToken, data) {
  const decoded = jws.decode(idToken);

  const header = decoded.header;
  const origHeader = Object.assign({}, header);
  header.kid = keys.publicJwk.kid;

  logDiff('Swapping id_token.header claims', origHeader, header);

  const claims = JSON.parse(decoded.payload);
  const origClaims = Object.assign({}, claims);

  // Replace nonce with the nonce sent by the client
  claims.nonce = data.nonce;

  // Replace issuer with this proxy server
  claims.iss = data.iss;

  // Express back-end validates access_token using the at_hash claim
  // Spring back-end validates the access_token using the signature & keys returned from jwks uri
  // To ensure spring access_token validation doesn't fail we need to sign the access_token with our keys 
  // This changes the payload of the access_token, which in turn changes the at_hash value
  // Now we to update the at_hash claim with the new hash, which is what we do here. Phew!
  if (data.at_hash != 'undefined') {
    claims.at_hash = data.at_hash;
  }
  
  // Update expiration time to expire in 1 hour
  const exp = Math.floor(new Date().getTime() / 1000) + 3600;
  claims.exp = exp;

  logDiff('Swapping id_token.payload claims', origClaims, claims);
  return jws.sign({
    header: decoded.header,
    payload: claims,
    secret: keys.privatePem,
  });
}

/**
 * Swaps the cached access_token with a new access_token that has a valid nonce, issuer,
 * and expiration time.
 *
 * @arg {string} access_token
 * @arg {object} data
 * @arg {string} data.nonce
 * @arg {string} data.iss
 */
function swapAccessToken(accessToken, data) {
  const decoded = jws.decode(accessToken);

  const header = decoded.header;
  const origHeader = Object.assign({}, header);
  header.kid = keys.publicJwk.kid;

  logDiff('Swapping accessToken.header claims', origHeader, header);

  const claims = JSON.parse(decoded.payload);
  const origClaims = Object.assign({}, claims);

  // Replace nonce with the nonce sent by the client
  claims.nonce = data.nonce;

  // Replace issuer with this proxy server
  claims.iss = data.iss;

  // Update expiration time to expire in 1 hour
  const exp = Math.floor(new Date().getTime() / 1000) + 3600;
  claims.exp = exp;

  logDiff('Swapping accessToken.payload claims', origClaims, claims);
  return jws.sign({
    header: decoded.header,
    payload: claims,
    secret: keys.privatePem,
  });
}


/**
 * Modifies the outgoing response headers to map to the incoming request, and
 * removes headers that cause inconsistent client behavior.
 *
 * @arg {object} headers - header key/val map
 * @arg {object} data
 * @arg {string} data.proxied - url
 * @arg {string} data.cdn - url
 * @arg {string} data.proxy - url
 * @arg {boolean} record - flag to indicate if mock server is running in record mode
 */
util.mapCachedHeadersToResponse = (headers, data, record) => {
  // Replace any proxied urls with this proxy server
  const mapped = {};
  Object.keys(headers).forEach((key) => {
    let val = headers[key];
    if (typeof val === 'string') {
      val = replaceUrls(val, data);
    }
    mapped[key] = val;
  });

  // Replace state in the redirect from the authorization flow (only during playback of the tapes)
  // While recording the tapes, we store whatever state is generated by the middleware into the tapes
  if (data.isRedirectCallback) {
    mapped.location = mapped.location.replace('state=STATE', `state=${data.state}`);   
  }

  // Turn off any caching headers to ensure consistent client requests,
  // especially in the recording flow
  mapped['cache-control'] = 'no-cache, no-store';
  mapped.pragma = 'no-cache';
  delete mapped.etag;
  delete mapped['last-modified'];

  logDiff('Mapping outgoing response headers from cache', headers, mapped);
  return mapped;
};

/**
 * Modifies the outgoing response body to map to the incoming request:
 * - Urls pointing to the proxied server are replaced with the proxy
 * - Replace variables that were stripped from the request, i.e state and nonce
 * - Swap out the id_token and access_token as needed
 *
 * @arg {string} chunk - Part or all of the response, depending on the size.
 * @arg {object} data - Request data used for replacing response content
 * @arg {boolean} record - Flag to indicate if we're in record mode
 *
 * Data about the proxy and the proxied server
 * @arg {string} data.proxy - url, i.e. http://localhost:7777
 * @arg {string} data.proxied - url, i.e. https://oswtests.oktapreview.com
 * @arg {string} data.cdn - url, i.e. https://op1static.oktacdn.com
 *
 * Data attached to the /authorize request
 * @arg {boolean} data.isAuthorizeReq
 * @arg {string} data.responseMode - response_mode
 * @arg {string} data.scope - original scope
 * @arg {string} data.nonce - original nonce
 *
 * Data attached to the /token request
 * @arg {boolean} data.isTokenReq
 *
 * @return {string} modified response body
 */
util.mapCachedBodyToResponse = (chunk, data, record) => {
  // Replace any proxied urls with the proxy server
  let newChunk = replaceUrls(chunk, data);

  // Set the issuer to be the proxy + OAuth 2.0 auth server
  const issuer = `${data.proxy}/oauth2/default`;

  // When the responseMode is okta_post_message, we must swap the id_token
  // and replace the state from the html body of the response
  if (data.isAuthorizeReq && data.responseMode === 'okta_post_message') {
    const idToken = newChunk.match(/data.id_token = '([^']+)'/)[1];

    const newIdToken = swapIdToken(idToken, {
      nonce: data.nonce,
      iss: issuer,
    });
    newChunk = newChunk.replace(idToken, newIdToken);

    const accessToken = newChunk.match(/"access_token":"([^"]+)"/)[1];
    const newAccessToken = swapAccessToken(accessToken, {
      nonce: data.nonce,
      iss: issuer,
    });
    newChunk = newChunk.replace(accessToken, newAccessToken);
  }

  // When the id_token is returned from the token endpoint, we just need to
  // swap the id_token in the json body 
  // For spring back-end, we also need to swap the access_token by signing it
  // with our own private key
  if (data.isTokenReq) {
    // Always record tapes using express back-end, where we only need to swap id_token
    // For express, we don't need to sign the access_token
    if (record) {
      const idToken = newChunk.match(/"id_token":"([^"]+)"/)[1];
      const newIdToken = swapIdToken(idToken, {
        nonce: data.nonce,
        iss: issuer
      });
      newChunk = newChunk.replace(idToken, newIdToken);
    } else {
      // While playing back the tapes, sign access_token with our key and swap it
      const accessToken = newChunk.match(/"access_token":"([^"]+)"/)[1];
      const newAccessToken = swapAccessToken(accessToken, {
        nonce: data.nonce,
        iss: issuer,
      });
      newChunk = newChunk.replace(accessToken, newAccessToken);
      
      // Calculate the new at_hash and add it in the id_token payload
      const atHash = tokenHash.generate(newAccessToken, 'sha256');
  
      const idToken = newChunk.match(/"id_token":"([^"]+)"/)[1];
      const newIdToken = swapIdToken(idToken, {
        nonce: data.nonce,
        iss: issuer,
        at_hash: atHash
      });
      newChunk = newChunk.replace(idToken, newIdToken);
    }
  }

  return newChunk;
};
