import { processGraphqlRequest } from "../../execution";
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "http";
import { GraphQLSchema } from "graphql/type";
import { GraphQLError } from "graphql/error";
import {
  GraphQLRequest,
  GraphQLResponse,
  isErrorBeforeExecution,
  isErrorDuringExecution,
} from "../../types";

/**
 * This interface correlates to the `req.IncomingMessage` type, in a Node.js
 * agnostic way.
 */
export interface IHttpRequest {
  /**
   * The HTTP method of the request (e.g. POST, GET, HEAD, OPTIONS).
   *
   * While we could string-ly type this to the types that HTTP supports, the
   * Node.js `req.IncomingMessage` doesn't enumerate that finite list of
   * standardized methods, instead only typing it as `string`.  Therefore, we
   * currently do the same.
   */
  method: string;
  headers: IncomingHttpHeaders;

  /**
   * The requested URL.  It's unlikely that we should be doing anything with
   * this within the server, but suspect it would be available from many
   * transports.
   */
  url?: string;
  parsedRequest: GraphQLRequest;
}

export interface IHttpResponse {
  /**
   * The numeric representation of the HTTP status code.
   */
  statusCode: number;
  /**
   * An optional string specification of the HTTP status code.
   *
   * @remarks
   *
   * For known status codes, it's recommended to use the [IANA official status
   * messages], though handlers may define this as they wish.
   *
   * [IANA official status messages]: https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml
   */
  statusMessage?: string;
  /**
   * This returns an `AsyncIterable` which could include multiple responses.
   * It is up to the implementing HTTP handler to decide what it does with
   * this.
   */
  body: AsyncIterable<GraphQLResponse>;
  headers: OutgoingHttpHeaders;
}

/** Options for {@link processHttpRequest} */
interface IProcessHttpRequestArgs {
  schema: GraphQLSchema;
  request: IHttpRequest;
}

/**
 * Process an HTTP request.
 *
 * This is meant to be invoked from an HTTP handler which has
 * coerced its input values to match the interface expectations
 * of this
 *
 */
export async function processHttpRequest(
  /**
   * This `IProcessHttpRequestArgs` interface is expected to be mapped from
   * the incoming request by the HTTP handler, which itself should invoke this
   * function.
   */
  args: IProcessHttpRequestArgs,
): Promise<IHttpResponse> {
  const { schema, request } = args;

  if (request.method !== 'POST' && request.method !== 'GET') {
    return generatedResponse({
      response: {
        // TODO(AS3) This should be a HTTP status code 405.
        errors: [new GraphQLError("Unsupported method")],
      },
    });
  }

  try {
    return generatedResponse({
      response: await processGraphqlRequest({
        schema,
        request: request.parsedRequest,
      }),
    });
  } catch (err) {
    return generatedResponse({
      response: {
        errors: [new GraphQLError("Internal server error")],
      },
    });
  }
}

/**
 * Generate the response to return to the HTTP transport.
 *
 * TODO(AS3) Yet to be determined, is how the setting of additional headers
 * should be handled.
 *
 * @param response
 */
export function generatedResponse(args: {
  response: GraphQLResponse;
  headers?: OutgoingHttpHeaders;
}): IHttpResponse {
  const {
    response,
    headers = Object.create(null),
  } = args;

  /**
   * In the future, GraphQL execution should return an `AsyncIterable`. However,
   * today it returns a `Promise`, so we'll coerce it into an `AsyncIterable`
   * with a generator function implemented on a `Symbol.asyncIterator` property.
   */
  const body = {
    [Symbol.asyncIterator]: async function*() {
      yield response;
    },
  };

  const statusCode: number = statusCodeForResponse(response);

  return {
    body,
    statusCode,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  };
}

/**
 * Convert a singular `GraphQLError` to an HTTP status code.
 *
 * TODO(AS3) This could be more defensive since, at the moment, we don't check
 * this against a known error type — e.g. `ValidationError`, `ParseError` — as
 * we did in Apollo Server 2.x.  For now, we just structurally check the error
 * to see if it matches characteristics of particular error types.
 *
 * More , the new execution pipeline doesn't actually throw these errors
 * right now, so this is the only technique we can currently employ.  While we
 * could re-use `apollo-server-errors` errors in Apollo Server 3, we may want to
 * consider another option, so I didn't want to reach for that package just yet.
 *
 * @param error A `GraphQLError` instance to reduce to a status code.
 */
export function statusCodeForError(error: GraphQLError): number {
  if (!(error instanceof GraphQLError)) {
    return 500;
  }

  if (
    error.source &&
    Array.isArray(error.positions) &&
    error.positions.length &&
    Array.isArray(error.locations) &&
    error.locations.length
  ) {
    if (Array.isArray(error.nodes) && error.nodes.length) {
      return 400; // Validation error
    }
    // TODO(AS3) A parse error, but we maybe should shore this up by using
    // specific error classes within `processGraphqlRequest`.
    return 400;
  }

  return 400;
}

/**
 * Generate an HTTP status code for a `GraphQLResponse`.
 *
 * @param response A `GraphQLResponse` which will be reduced to an HTTP status
 * code based on its `errors` and `data` properties (or lack thereof!).
 */
export function statusCodeForResponse(response: GraphQLResponse): number {
  const mixedResponseStatusCode = 207;
  const defaultExecutionStatusCode = 200;
  const defaultPreExecutionErrorStatusCode = 400;

  if (isErrorBeforeExecution(response)) {
    return response.errors.reduce((previousStatusCode, err) => {
      const thisStatusCode = statusCodeForError(err);
      if (thisStatusCode && thisStatusCode >= previousStatusCode) {
        return thisStatusCode;
      }

      return previousStatusCode;
    }, defaultPreExecutionErrorStatusCode);
  } else if (isErrorDuringExecution(response)) {
    return mixedResponseStatusCode;
  } else {
    return defaultExecutionStatusCode;
  }
}
