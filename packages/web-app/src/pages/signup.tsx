import {
  Box,
  Button,
  Center,
  Flex,
  FormControl,
  FormLabel,
  Input,
  InputGroup,
  InputLeftElement,
  VStack,
  Text,
  Link,
} from "@chakra-ui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope, faLock } from "@fortawesome/free-solid-svg-icons";
import { useState, ChangeEvent, FormEvent } from "react";
import { gql, useMutation } from "@apollo/client";

const SIGNUP_MUTATION = gql`
  mutation Signup($email: String!, $password: String!) {
    signup(email: $email, password: $password) {
      token
      user {
        id
        email
      }
    }
  }
`;

function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [signup] = useMutation(SIGNUP_MUTATION);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const { data, errors } = await signup({
        variables: { email, password },
      });

      if (errors) {
        setError(errors[0].message);
      } else {
        const { user, token } = data.signup;
        console.log("User created successfully:", user);
        localStorage.setItem("authToken", token);
        localStorage.setItem("userEmail", email);

        // Redirect to home page
        window.location.href = "/campaigns";
      }
    } catch (error: any) {
      setError(error.message);
    }
  }

  return (
    <Flex
      minHeight="calc(100vh - 60px)"
      alignItems="center"
      justifyContent="center"
      bgGradient="linear(to-r, #F8FAFC, #708196)"
    >
      <Center
        as="form"
        onSubmit={handleSubmit}
        bg="white"
        boxShadow="2xl"
        borderRadius="xl"
        p={8}
        width="100%"
        maxWidth="500px"
      >
        <VStack spacing={6} width="69%">
          <Text fontSize="3xl" fontWeight="bold" color="teal.500">
            Create an account
          </Text>
          <FormControl id="email" isRequired>
            <FormLabel>Email:</FormLabel>
            <InputGroup>
              <InputLeftElement pointerEvents="none">
                <FontAwesomeIcon icon={faEnvelope} color="gray" />
              </InputLeftElement>
              <Input
                type="email"
                value={email}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setEmail(e.target.value)
                }
                width="100%"
                maxWidth="300px"
                pl="40px"
              />
            </InputGroup>
          </FormControl>
          <FormControl id="password" isRequired>
            <FormLabel>Password:</FormLabel>
            <InputGroup>
              <InputLeftElement pointerEvents="none">
                <FontAwesomeIcon icon={faLock} color="gray" />
              </InputLeftElement>
              <Input
                type="password"
                value={password}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setPassword(e.target.value)
                }
                width="100%"
                maxWidth="300px"
                pl="40px"
              />
            </InputGroup>
          </FormControl>
          <Button type="submit" colorScheme="teal" size="md">
            Sign up
          </Button>
          <Text fontSize="sm">
            Already have an account?{" "}
            <Link href="/login">
              <Text as="span" color="teal.500" textDecoration="underline">
                Login
              </Text>
            </Link>
          </Text>
        {error && (
          <Text color="red.500" textAlign="center" marginTop={4}>
            Error: {error}
          </Text>
        )}
        </VStack>
      </Center>
    </Flex>
  );
}

export default Signup;
